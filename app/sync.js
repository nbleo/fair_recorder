/* FairRecorder — GitHub 云端备份
 *
 * 架构参考 glink25/Cent（纯前端 PWA + GitHub 仓库即数据库），取其四点：
 *
 *  1. **本地是唯一真相源**。手机 IndexedDB 先落盘，云端只是备份通道。
 *     Cent 的 BillIndexedDBStorage + tidal 就是这个分工；同步失败只记日志，
 *     绝不阻断录入。
 *  2. **Syncer 抽象**。本文件只依赖 fetchStructure / fetchContent / uploadContent /
 *     getUserInfo / getCollaborators 这几个动作；换成 Gitee、S3、WebDAV 只需
 *     再实现一遍同样的接口（Cent 正是这么做的）。
 *  3. **分块 + 增量**。数据切成 suppliers-<start>.json，按记录 updatedAt 算出
 *     脏块，只上传变化的块；照片上传过就不再重传。Cent 的 itemsPerChunk 同理。
 *  4. **串行调度**。同一 git ref 并发提交必然 non-fast-forward，Cent 用 Scheduler
 *     串行化；这里同样保证任何时刻只有一个同步在跑。
 *
 * 与 Cent 的差异（展会场景需要）：
 *  - Cent 是「一个账本 = 一个仓库」；这里是「一个私有仓库 + 按访问者分命名空间」，
 *    因为供应商数据要按人隔离，而不是按账本拆成一堆仓库。
 *  - Cent 依赖仓库私有性；这里额外提供可选的 AES-GCM 加密，即使仓库被误设为公开
 *    或协作者被加入，落到云端的仍是密文。
 *
 * 照片走 Git Data API（blobs -> tree -> commit -> ref）而非 Contents API，
 * 因为 Contents API 单文件上限 1 MB，压缩后的手机照片动辄几百 KB。
 */
(function () {
  "use strict";

  /* ============================ 常量 ============================ */

  const ITEMS_PER_CHUNK = 200;          // 每个分块的记录数（Cent 用 1000）
  const LAYOUT = "fairrecorder/per-user/v2";
  const LEGACY_LAYOUT = "per-fair/v1";  // 旧版单文件路径，拉取时兼容

  /* 公开的程序仓：只放代码与 Pages，永远不写数据 */
  const PUBLIC_CODE_REPOS = [
    { owner: "nbleo", repo: "fair_recorder" },
  ];

  const DEFAULTS = {
    owner: "", repo: "", branch: "main", root: "users",
    token: "", login: "", namespace: "",
    scope: "meta", autoMode: "off", autoScope: "meta",
    encrypt: false,
    repoPrivate: null,      // null = 未校验；true/false = 上次校验结果
    lastSyncAt: null,
  };
  let S = Object.assign({}, DEFAULTS);

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function log(msg) {
    const el = $("#syLog");
    if (!el) return;
    const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    el.innerHTML = `<div style="margin-bottom:4px"><b>${esc(t)}</b> ${esc(msg)}</div>` + el.innerHTML;
  }

  /* ============================ 配置 ============================ */

  async function loadCfg() {
    const saved = await FR.getKV("gh", null);
    S = Object.assign({}, DEFAULTS, saved || {});
    const auto = await FR.getKV("autoSync", null);
    if (auto) { S.autoMode = auto.mode || "off"; S.autoScope = auto.scope || "meta"; }
  }
  async function saveCfg() {
    await FR.setKV("gh", {
      owner: S.owner, repo: S.repo, branch: S.branch, root: S.root, token: S.token,
      login: S.login, namespace: S.namespace, scope: S.scope, encrypt: S.encrypt,
      repoPrivate: S.repoPrivate, lastSyncAt: S.lastSyncAt,
    });
    await FR.setKV("autoSync", { mode: S.autoMode, scope: S.autoScope });
  }
  function configured() { return !!(S.owner && S.repo && S.token); }
  function ready() { return configured() && !!FR.fair; }   // 供自动备份定时器判断

  /* 命名空间：默认用 GitHub 登录名，读不到 /user 时用手填的 namespace */
  function who() {
    return (S.login || S.namespace || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  }

  /* ============================ 路径 ============================ */

  function userRoot() {
    const w = who();
    if (!w) throw new Error("未确定访问者身份：请先在云同步里「测试连接」，或手填命名空间");
    return `${(S.root || "users").replace(/^\/+|\/+$/g, "")}/${w}`;
  }
  function fairRoot() {
    const f = FR.fair;
    if (!f) throw new Error("未选择展会");
    return `${userRoot()}/fairs/${f.id}`;
  }
  function metaPath() { return `${fairRoot()}/meta.json`; }
  function chunkPath(start) { return `${fairRoot()}/suppliers-${start}.json`; }
  function assetPath(id) { return `${fairRoot()}/assets/${id}.jpg`; }
  /* 旧版路径，仅用于向下兼容读取 */
  function legacyMetaPath() {
    const f = FR.fair;
    return f ? `fairs/${f.id}/suppliers.json` : null;
  }

  /* ============================ GitHub Syncer ============================ */
  /* 只暴露 Cent 那样的一组动作，便于日后换后端 */

  let _ctrl = null;   // 当前同步的 AbortController

  async function api(method, url, body, signal) {
    const headers = {
      Authorization: "Bearer " + S.token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (body) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch("https://api.github.com" + url, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
        signal: signal || (_ctrl && _ctrl.signal) || undefined,
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new Error("网络不可达（" + (e.message || e) + "）");
    }
    if (!res.ok) {
      let extra = "";
      try {
        const j = await res.json();
        if (j && j.message) extra = " — " + j.message;
      } catch (e) { /* 非 JSON 响应 */ }
      throw new Error(res.status + " " + res.statusText + extra);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  const Syncer = {
    /* fetchStructure: 远端目录结构 */
    async fetchStructure() {
      const tr = await api("GET",
        `/repos/${S.owner}/${S.repo}/git/trees/${S.branch}?recursive=1`);
      const tree = tr.tree || [];
      return {
        tree,
        has: (p) => tree.some((x) => x.path === p),
        find: (p) => tree.find((x) => x.path === p) || null,
        prefix: (p) => tree.filter((x) => x.path.startsWith(p)),
      };
    },

    /* fetchContent: 按 sha 取回 blob 内容 */
    async fetchContent(entry, asText) {
      const b = await api("GET", `/repos/${S.owner}/${S.repo}/git/blobs/${entry.sha}`);
      if (b.content == null) return asText ? "" : new Blob([]);
      const bin = atob(String(b.content).replace(/\n/g, ""));
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      if (asText) return new TextDecoder().decode(arr);
      return new Blob([arr], { type: "image/jpeg" });
    },

    /* uploadContent: blobs -> tree -> commit -> update ref（一步提交） */
    async uploadContent(files, message) {
      const ref = await api("GET", `/repos/${S.owner}/${S.repo}/git/ref/heads/${S.branch}`);
      const parentSha = ref.object.sha;
      const parent = await api("GET", `/repos/${S.owner}/${S.repo}/git/commits/${parentSha}`);

      const tree = [];
      for (const f of files) {
        const b = await api("POST", `/repos/${S.owner}/${S.repo}/git/blobs`,
          { content: f.b64, encoding: "base64" });
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: b.sha });
        f.b64 = null;                                   // 边传边释放内存
      }
      const t = await api("POST", `/repos/${S.owner}/${S.repo}/git/trees`,
        { base_tree: parent.tree.sha, tree });
      const c = await api("POST", `/repos/${S.owner}/${S.repo}/git/commits`,
        { message, tree: t.sha, parents: [parentSha] });
      await api("PATCH", `/repos/${S.owner}/${S.repo}/git/refs/heads/${S.branch}`,
        { sha: c.sha });
      return c.sha;
    },

    async getUserInfo() {
      const u = await api("GET", "/user");
      return { login: u.login, name: u.name || u.login, avatar: u.avatar_url || "", id: u.id };
    },
    async getCollaborators() {
      try {
        const list = await api("GET",
          `/repos/${S.owner}/${S.repo}/collaborators?per_page=100`);
        return (list || []).map((c) => ({
          login: c.login, avatar: c.avatar_url || "",
          role: (c.permissions || {}).admin ? "admin"
            : (c.permissions || {}).push ? "write" : "read",
        }));
      } catch (e) {
        return null;      // 读不到协作者不致命（token 权限不足）
      }
    },
  };

  /* ============================ 编码 ============================ */

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || "").slice(String(r.result).indexOf(",") + 1));
      r.onerror = () => reject(r.error || new Error("read failed"));
      r.readAsDataURL(blob);
    });
  }
  function strToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(bin);
  }
  function b64ToStr(b64) {
    const bin = atob(String(b64).replace(/\n/g, ""));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(arr);
  }
  function bytesToB64(u8) {
    let bin = "";
    const step = 0x8000;
    for (let i = 0; i < u8.length; i += step) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + step));
    }
    return btoa(bin);
  }

  /* ============================ 可选加密（AES-GCM + PBKDF2） ============================ */
  /* 与 Cent 的 utils/encrypt.ts 同一套参数：PBKDF2-SHA256 / 100000 轮 / AES-GCM-256。
   * 只对 suppliers-*.json 与 assets/*.jpg 加密；meta.json 保持明文，
   * 因为里面要放 salt（salt 本就无需保密）和统计数字，方便快速看远端状态。 */

  const ENC = { alg: "AES-GCM-256", kdf: "PBKDF2-SHA256", iterations: 100000 };

  async function deriveKey(pass, saltB64) {
    const enc = new TextEncoder();
    const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
    const km = await crypto.subtle.importKey("raw", enc.encode(pass),
      { name: "PBKDF2" }, false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: ENC.iterations, hash: "SHA-256" },
      km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  function newSaltB64() {
    const s = crypto.getRandomValues(new Uint8Array(16));
    return bytesToB64(s);
  }
  async function encJSON(obj, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
    return { enc: 1, alg: ENC.alg, iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) };
  }
  async function decJSON(payload, key) {
    const iv = Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(payload.ct), (c) => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function encBlob(blob, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key,
      await blob.arrayBuffer());
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), 12);
    return new Blob([out], { type: "application/octet-stream" });
  }
  async function decBlob(blob, key) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf.subarray(0, 12) }, key, buf.subarray(12));
    return new Blob([pt], { type: "image/jpeg" });
  }

  /* 加密时把口令与 salt 一起准备好；未开启加密返回 null */
  async function cryptoCtx(remoteMeta) {
    if (!S.encrypt) return null;
    const pass = ($("#syPass") && $("#syPass").value) || "";
    if (!pass) throw new Error("已开启云端加密，请填写加密口令（忘记则无法恢复云端数据）");
    const salt = (remoteMeta && remoteMeta.enc && remoteMeta.enc.salt) || newSaltB64();
    return { key: await deriveKey(pass, salt), salt, enc: Object.assign({}, ENC, { salt }) };
  }

  /* ============================ 安全校验 ============================ */

  async function assertSafe() {
    const hit = PUBLIC_CODE_REPOS.find((c) =>
      c.owner.toLowerCase() === String(S.owner).toLowerCase()
      && c.repo.toLowerCase() === String(S.repo).toLowerCase());
    if (hit) {
      throw new Error(`「${hit.owner}/${hit.repo}」是公开的程序仓库（Pages 站点），`
        + "只放代码。供应商数据请填私有数据仓库。");
    }
    const r = await api("GET", `/repos/${S.owner}/${S.repo}`);
    S.repoPrivate = !!r.private;
    await saveCfg();
    if (!r.private) {
      throw new Error(`「${r.full_name}」是公开仓库，拒绝上传。请在 Settings 里改成 Private，`
        + "或新建一个私有仓库——供应商名单与照片绝不能进公开仓。");
    }
    return r;
  }

  async function testConnection() {
    if (!configured()) throw new Error("请先填写 owner / repo / token");
    const r = await api("GET", `/repos/${S.owner}/${S.repo}`);
    S.repoPrivate = !!r.private;
    let whoTxt = "身份未知";
    try {
      const u = await Syncer.getUserInfo();
      S.login = u.login;
      whoTxt = u.login;
    } catch (e) {
      whoTxt = "读不到身份（改用下方手填命名空间）";
    }
    await saveCfg();
    const vis = r.private ? "私有 ✅" : "公开 ⚠️（已禁止上传）";
    return `${r.full_name} · ${vis} · 分支 ${r.default_branch} · 访问者 ${whoTxt}`;
  }

  /* ============================ 分块 ============================ */

  /* 记录按 id 排序后切块，保证同一条记录的块下标稳定（删除只是墓碑，不会前移） */
  function chunkItems(items) {
    const sorted = items.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const out = [];
    for (let i = 0; i < sorted.length; i += ITEMS_PER_CHUNK) {
      out.push({ start: i, path: chunkPath(i), items: sorted.slice(i, i + ITEMS_PER_CHUNK) });
    }
    if (!out.length) out.push({ start: 0, path: chunkPath(0), items: [] });
    return out;
  }

  function isDirty(rec, since) {
    if (!since) return true;
    return String(rec.updatedAt || rec.createdAt || "") > since;
  }

  /* ============================ 上传 ============================ */

  async function push(scope) {
    if (!configured()) throw new Error("请先填写 owner / repo / token");
    await assertSafe();
    await FR.refresh();

    const st = await Syncer.fetchStructure();
    const mp = metaPath();
    let remoteMeta = null;
    try {
      const e = st.find(mp);
      if (e) remoteMeta = JSON.parse(await Syncer.fetchContent(e, true));
    } catch (e) { remoteMeta = null; }

    const ctx = await cryptoCtx(remoteMeta);

    const { bundle, photos } = await FR.buildBundle("full");
    const fair = Object.assign({}, bundle.fair || {}, { id: FR.fair.id });

    /* --- 分块 + 增量 --- */
    const items = (bundle.suppliers || []).slice();
    const chunks = chunkItems(items);
    const since = FR.fair.lastPushAt || null;
    const dirty = new Set();
    items.forEach((s, i) => {
      if (isDirty(s, since)) dirty.add(Math.floor(i / ITEMS_PER_CHUNK));
    });
    if (!remoteMeta || remoteMeta.layout !== LAYOUT) chunks.forEach((c, i) => dirty.add(i));

    const files = [];
    for (let i = 0; i < chunks.length; i++) {
      if (!dirty.has(i)) continue;
      const payload = { start: chunks[i].start, count: chunks[i].items.length, items: chunks[i].items };
      const body = ctx ? await encJSON(payload, ctx.key) : payload;
      files.push({ path: chunks[i].path, b64: strToBase64(JSON.stringify(body)) });
    }

    /* --- 照片：上传过就不再重传 --- */
    let newPhotos = 0, skipped = 0;
    if (scope === "full") {
      for (const p of photos) {
        const pth = assetPath(p.id);
        if (st.has(pth)) { skipped++; continue; }
        const blob = ctx ? await encBlob(p.blob, ctx.key) : p.blob;
        files.push({ path: pth, b64: await blobToBase64(blob) });
        newPhotos++;
      }
    }

    /* --- meta.json：明文，含统计与加密参数 --- */
    const meta = {
      layout: LAYOUT,
      app: "FairRecorder",
      user: who(),
      fair: { id: fair.id, name: fair.name || "", nameEn: fair.nameEn || "",
              phase: fair.phase || "", startDate: fair.startDate || "", endDate: fair.endDate || "" },
      updatedAt: new Date().toISOString(),
      counts: {
        suppliers: bundle.export.counts.suppliers,
        photos: (bundle.photos || []).length,
        plans: (bundle.visitPlans || []).length,
        tombstones: bundle.export.counts.tombstones,
      },
      chunks: chunks.map((c) => ({ path: c.path, start: c.start, count: c.items.length })),
      uploadedPhotos: scope === "full" ? (bundle.photos || []).map((p) => assetPath(p.id)) : null,
      weights: bundle.export.weights,
      encrypted: !!ctx,
      enc: ctx ? ctx.enc : null,
    };
    files.push({ path: mp, b64: strToBase64(JSON.stringify(meta)) });

    const label = FR.fair ? (FR.fair.name || FR.fair.nameEn || FR.fair.id.slice(0, 8)) : "";
    const sha = await Syncer.uploadContent(files,
      `FairRecorder backup — ${who()} — ${label} — ${new Date().toISOString()} — `
      + `${meta.counts.suppliers} suppliers, ${newPhotos} photos`
      + (scope === "full" ? "" : " (metadata only)")
      + (ctx ? " [encrypted]" : ""));

    S.lastSyncAt = new Date().toISOString();
    await saveCfg();
    await FR.markPushed(S.lastSyncAt);
    log(`分块 ${chunks.length} 个，本次上传 ${dirty.size} 个脏块 / ${newPhotos} 张新照片`
      + (skipped ? `（跳过 ${skipped} 张已上传）` : ""));
    return { files: files.length, chunks: dirty.size, photos: newPhotos, skipped, sha: sha.slice(0, 7) };
  }

  /* ============================ 拉取 ============================ */

  async function readMeta(st) {
    const mp = metaPath();
    const e = st.find(mp);
    if (e) {
      const m = JSON.parse(await Syncer.fetchContent(e, true));
      m.__path = mp;
      return m;
    }
    const legacy = legacyMetaPath();
    if (legacy && st.has(legacy)) {                    // 旧版单文件布局
      const raw = JSON.parse(await Syncer.fetchContent(st.find(legacy), true));
      return { layout: LEGACY_LAYOUT, __path: legacy, __legacy: raw };
    }
    return null;
  }

  async function pull() {
    if (!configured()) throw new Error("请先填写 owner / repo / token");
    if (!FR.fair) throw new Error("未选择展会");

    const st = await Syncer.fetchStructure();
    const meta = await readMeta(st);
    if (!meta) throw new Error("云端没有本展会的备份，请先上传一次");

    /* 旧版布局：直接是一整个 bundle */
    if (meta.layout === LEGACY_LAYOUT) {
      const data = meta.__legacy;
      await ensureFair(data.fair);
      return applyBundle(data, st, null);
    }

    /* 新版布局 */
    await ensureFair(meta.fair);
    let key = null;
    if (meta.encrypted) {
      const pass = ($("#syPass") && $("#syPass").value) || "";
      if (!pass) throw new Error("云端数据已加密，请先在上方填写加密口令再恢复");
      if (!meta.enc || !meta.enc.salt) throw new Error("云端缺少加密参数，无法解密");
      key = await deriveKey(pass, meta.enc.salt);
    }

    const suppliers = [];
    for (const c of meta.chunks || []) {
      const e = st.find(c.path);
      if (!e) continue;
      const parsed = JSON.parse(await Syncer.fetchContent(e, true));
      const payload = (parsed && parsed.enc === 1)
        ? await decJSON(parsed, key) : parsed;
      for (const s of payload.items || []) suppliers.push(s);
    }

    const bundle = {
      suppliers,
      visitPlans: [],
      photos: (meta.uploadedPhotos || []).map((p) => ({
        id: p.split("/").pop().replace(/\.jpg$/, ""), path: p, supplierId: null,
      })),
    };
    return applyBundle(bundle, st, key);
  }

  async function ensureFair(f) {
    if (!f || !f.id) return;
    const known = await FR.all("fairs");
    if (known.some((x) => x.id === f.id)) return;
    await FR.put("fairs", Object.assign({
      id: f.id, name: "", nameEn: "", city: "", venue: "", area: "", phase: "",
      startDate: "", endDate: "", defaultHall: "A区", notes: "", archived: false,
      lastPushAt: null, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), deletedAt: null,
    }, f));
    await FR.refresh();
  }

  /* 云端 -> 本地：只覆盖云端更新的版本，本地较新的不动 */
  async function applyBundle(data, st, key) {
    let ns = 0, nv = 0, np = 0;
    for (const s of data.suppliers || []) {
      const cur = await FR.get("suppliers", s.id);
      if (!cur || new Date(s.updatedAt || 0) > new Date(cur.updatedAt || 0)) {
        await FR.put("suppliers", s); ns++;
      }
    }
    for (const p of data.visitPlans || []) {
      const cur = await FR.get("visitPlans", p.id);
      if (!cur || new Date(p.updatedAt || 0) > new Date(cur.updatedAt || 0)) {
        await FR.put("visitPlans", p); nv++;
      }
    }
    for (const pm of data.photos || []) {
      const cur = await FR.get("photos", pm.id);
      if (cur) continue;
      const p = pm.path || assetPath(pm.id);
      const e = st.find(p);
      if (!e) continue;
      let blob = await Syncer.fetchContent(e, false);
      if (key) blob = await decBlob(blob, key);
      await FR.put("photos", {
        id: pm.id, fairId: FR.fair ? FR.fair.id : null, supplierId: pm.supplierId,
        type: pm.type || "other", blob, thumbBlob: await FR.compress(blob, 320, 0.7),
        size: blob.size, sha256: pm.sha256 || "",
        createdAt: pm.createdAt || new Date().toISOString(),
      });
      np++;
    }
    await FR.refresh();
    S.lastSyncAt = new Date().toISOString();
    await saveCfg();
    return { suppliers: ns, plans: nv, photos: np, remote: (data.suppliers || []).length };
  }

  async function remoteCount() {
    try {
      const st = await Syncer.fetchStructure();
      const meta = await readMeta(st);
      if (!meta) return "无本展会备份";
      if (meta.layout === LEGACY_LAYOUT) {
        const d = meta.__legacy;
        return `旧版布局 · ${(d.suppliers || []).length} 条 · ${(d.photos || []).length} 张`;
      }
      const enc = meta.encrypted ? " · 已加密" : "";
      return `${meta.counts.suppliers} 条 · ${meta.counts.photos} 张 · ${meta.chunks.length} 块${enc}`;
    } catch (e) {
      return "读取失败：" + e.message;
    }
  }

  /* ============================ 串行调度 ============================ */
  /* 同一时刻只允许一个同步在跑；后来的请求覆盖等待中的那个（Cent 的 Scheduler 同思路） */

  const Scheduler = (function () {
    let inflight = null, pending = null;
    function run(fn) {
      if (inflight) { pending = fn; return inflight; }
      _ctrl = new AbortController();
      inflight = (async () => {
        try { return await fn(); }
        finally {
          inflight = null; _ctrl = null;
          if (pending) { const next = pending; pending = null; run(next); }
        }
      })();
      return inflight;
    }
    return { run, get busy() { return !!inflight; } };
  })();

  /* ============================ UI ============================ */

  async function renderStatus() {
    const pend = FR.pendingChanges();
    const set = (id, v, color) => {
      const el = $(id); if (!el) return;
      el.textContent = v; if (color) el.style.color = color;
    };
    set("#syPending", pend ? `${pend} 条待上传` : "无（本地与云端一致）",
      pend ? "var(--warn)" : "var(--accent)");
    set("#syLocal", `${FR.suppliers.length} 条 / ${FR.photos.length} 张`);
    set("#syLast", S.lastSyncAt ? new Date(S.lastSyncAt).toLocaleString("zh-CN") : "从未");
    set("#syWho", S.login || S.namespace || "未确定");
    try { set("#sySpace", FR.fair ? fairRoot() : "未选择展会"); }
    catch (e) { set("#sySpace", "需先确定访问者身份"); }
    set("#syFair", FR.fair ? (FR.fair.name || FR.fair.nameEn || "（未命名）") : "未选择展会");

    set("#syVis", S.repoPrivate === true ? "私有 ✅ 可备份"
      : S.repoPrivate === false ? "公开 ⚠️ 已禁止上传"
      : (configured() ? "未校验" : "未配置"),
      S.repoPrivate === true ? "var(--accent)"
        : S.repoPrivate === false ? "var(--danger)" : "var(--muted)");

    set("#syCollab", "读取中…");
    set("#syRemote", configured() && FR.fair ? "读取中…" : "未配置");
    if (configured() && FR.fair) {
      remoteCount().then((r) => set("#syRemote", r)).catch(() => set("#syRemote", "读取失败"));
      Syncer.getCollaborators().then((c) => {
        if (!c) { set("#syCollab", "读不到（token 权限不足）"); return; }
        set("#syCollab", c.length ? c.map((x) => x.login).join("、") : "仅仓库 owner");
      });
    }
  }

  window.renderSync = async function () {
    await loadCfg();
    const set = (id, v) => { const el = $(id); if (el) el.value = v || ""; };
    set("#syOwner", S.owner); set("#syRepo", S.repo); set("#syBranch", S.branch);
    set("#syRoot", S.root); set("#syToken", S.token); set("#syNamespace", S.namespace);

    const chip = (group, val) => {
      $$(`#${group} .chip`).forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.v === String(val))));
    };
    chip("syScope", S.scope);
    chip("syAuto", S.autoMode);
    chip("syAutoScope", S.autoScope);
    chip("syEnc", S.encrypt ? "on" : "off");

    await renderStatus();

    const bind = (group, fn) => $$(`#${group} .chip`).forEach((b) => {
      b.onclick = async () => {
        chip(group, b.dataset.v);
        await fn(b.dataset.v, b.textContent.trim());
      };
    });
    bind("syScope", async (v) => { S.scope = v; await saveCfg(); });
    bind("syAuto", async (v, txt) => { S.autoMode = v; await saveCfg(); log("自动备份：" + txt); });
    bind("syAutoScope", async (v) => { S.autoScope = v; await saveCfg(); });
    bind("syEnc", async (v, txt) => {
      S.encrypt = v === "on";
      await saveCfg();
      log("云端加密：" + txt + (S.encrypt ? "（请务必记住口令，丢失无法恢复）" : ""));
    });

    $("#sySave").onclick = async () => {
      S.owner = $("#syOwner").value.trim();
      S.repo = $("#syRepo").value.trim();
      S.branch = $("#syBranch").value.trim() || "main";
      S.root = $("#syRoot").value.trim() || "users";
      S.token = $("#syToken").value.trim();
      S.namespace = $("#syNamespace").value.trim();
      S.repoPrivate = null;                         // 换仓库后必须重新校验
      await saveCfg();
      log("配置已保存到本机");
      FR.toast("已保存");
      await renderStatus();
    };

    $("#syTest").onclick = async () => {
      try {
        log("测试连接…");
        const r = await testConnection();
        log("连接成功：" + r);
        FR.toast("连接成功", 3000);
        await renderStatus();
      } catch (e) { log("连接失败：" + e.message); FR.toast("连接失败：" + e.message, 4000); }
    };

    const doPush = async (scope, label) => {
      try {
        log("开始备份（" + label + "）…");
        const r = await Scheduler.run(() => push(scope));
        if (!r) return;                              // 被后来的请求顶掉
        log(`备份完成：${r.files} 个文件（脏块 ${r.chunks}，新照片 ${r.photos}，`
          + `跳过 ${r.skipped}），commit ${r.sha}`);
        FR.toast("备份完成", 4000);
        await renderStatus();
      } catch (e) {
        if (e && e.name === "AbortError") { log("备份已取消（有新的同步请求）"); return; }
        log("备份失败：" + e.message); FR.toast("备份失败：" + e.message, 5000);
      }
    };
    $("#syPush").onclick = () => doPush(S.scope,
      S.scope === "full" ? "元数据 + 原图" : "仅元数据");
    $("#syPushFull").onclick = () => doPush("full", "元数据 + 原图，流量大");

    $("#syPull").onclick = async () => {
      try {
        if (!confirm("从云端恢复到本展会：只覆盖云端更新的版本，本机较新的记录不会被覆盖。继续？")) return;
        log("开始拉取…");
        const r = await Scheduler.run(() => pull());
        if (!r) return;
        log(`拉取完成：记录 ${r.suppliers} / 计划 ${r.plans} / 照片 ${r.photos}（云端共 ${r.remote} 条）`);
        FR.toast("恢复完成", 4000);
        await renderStatus();
      } catch (e) {
        if (e && e.name === "AbortError") { log("拉取已取消"); return; }
        log("拉取失败：" + e.message); FR.toast("拉取失败：" + e.message, 5000);
      }
    };

    $("#syInvite").onclick = () => {
      if (!configured()) { FR.toast("请先填写并保存 owner / repo", 4000); return; }
      window.open(`https://github.com/${S.owner}/${S.repo}/settings/access`, "_blank");
      log("已打开协作邀请页：Settings → Collaborators → Add people");
    };
  };

  /* 供自动备份定时器调用 */
  window.FRSync = {
    push, pull, ready, testConnection,
    get busy() { return Scheduler.busy; },
    /* 测试钩子：让 tests/ 能验证 JS 加密 ↔ Python 解密 的互操作性 */
    _crypto: { deriveKey, newSaltB64, encJSON, decJSON, encBlob, decBlob, ENC },
    async pushIfPending(scope) {
      if (!ready() || Scheduler.busy) return null;
      if (FR.pendingChanges() === 0) return null;
      return Scheduler.run(() => push(scope || S.autoScope || "meta"));
    },
  };
})();
