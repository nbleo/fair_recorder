/* FairRecorder — GitHub 云端备份
 *
 * 设计原则
 * --------
 * 1. **本地优先**：手机 IndexedDB 永远是第一副本。任何写操作都先落本地，
 *    云端只是备份通道。同步失败不影响录入，失败静默，下次再试。
 * 2. **不实时同步**：只在用户点「立即备份」或定时器到期时上传。
 *    展馆里网络差、流量贵，实时同步只会拖慢录入并制造失败提示。
 * 3. **按展会隔离**：云端路径 fairs/<fairId>/…，一届展会一个目录，
 *    与本地数据空间一一对应。
 * 4. **只写私有仓库**：上传前强制校验 repo.private === true，
 *    公开仓库直接拒绝——供应商名单和照片绝不能进公开仓。
 *
 * 照片走 Git Data API（blobs -> tree -> commit -> ref）而不是 Contents API，
 * 因为 Contents API 单文件上限 1 MB，而压缩后的手机照片动辄几百 KB。
 */
(function () {
  "use strict";

  const DEFAULTS = {
    owner: "", repo: "", branch: "main", root: "fairs",
    token: "", scope: "meta", autoMode: "off", autoScope: "meta",
    repoPrivate: null,        // 上次校验到的可见性（null = 未校验）
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

  // ------------------------------------------------------------------ 配置
  async function loadCfg() {
    const saved = await FR.getKV("gh", null);
    S = Object.assign({}, DEFAULTS, saved || {});
    const auto = await FR.getKV("autoSync", null);
    if (auto) { S.autoMode = auto.mode || "off"; S.autoScope = auto.scope || "meta"; }
  }
  async function saveCfg() {
    await FR.setKV("gh", {
      owner: S.owner, repo: S.repo, branch: S.branch, root: S.root, token: S.token,
      scope: S.scope, repoPrivate: S.repoPrivate, lastSyncAt: S.lastSyncAt,
    });
    await FR.setKV("autoSync", { mode: S.autoMode, scope: S.autoScope });
  }
  function configured() {
    return !!(S.owner && S.repo && S.token);
  }
  function ready() {                       // 供自动备份定时器判断
    return configured() && !!FR.fair;
  }

  function fairRoot() {
    const f = FR.fair;
    if (!f) throw new Error("未选择展会");
    return `${(S.root || "fairs").replace(/^\/+|\/+$/g, "")}/${f.id}`;
  }
  function metaPath() { return `${fairRoot()}/suppliers.json`; }
  function photoPath(id) { return `${fairRoot()}/photos/${id}.jpg`; }

  // ------------------------------------------------------------------ GitHub
  async function api(method, url, body) {
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
      });
    } catch (e) {
      throw new Error("网络不可达（" + e.message + "）");
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
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function b64ToBlob(b64, type) {
    const bin = atob(String(b64).replace(/\n/g, ""));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || "image/jpeg" });
  }

  /* 私有校验：公开仓库一律拒绝写入 */
  async function assertPrivate() {
    const r = await api("GET", `/repos/${S.owner}/${S.repo}`);
    S.repoPrivate = !!r.private;
    await saveCfg();
    if (!r.private) {
      throw new Error(`「${r.full_name}」是公开仓库，拒绝上传。请改成 Private，`
        + "或新建一个私有仓库（供应商名单与照片不能进公开仓）。");
    }
    return r;
  }

  async function testConnection() {
    if (!configured()) throw new Error("请先填写 owner / repo / token");
    const r = await api("GET", `/repos/${S.owner}/${S.repo}`);
    S.repoPrivate = !!r.private;
    await saveCfg();
    const vis = r.private ? "私有 ✅" : "公开 ⚠️（不能用于备份）";
    return `${r.full_name} · ${vis} · 默认分支 ${r.default_branch}`;
  }

  // ------------------------------------------------------------------- 上传
  async function push(scope) {
    if (!configured()) throw new Error("请先填写 owner / repo / token");
    await assertPrivate();
    await FR.refresh();

    const mp = metaPath();
    const { bundle, photos } = await FR.buildBundle("full");
    bundle.fair = bundle.fair || {};
    bundle.fair.id = FR.fair.id;
    bundle.cloud = { root: fairRoot(), metaPath: mp, layout: "per-fair/v1" };

    // 云端照片路径与 ZIP 不同：按 ID 平铺，避免中文路径
    bundle.photos = (bundle.photos || []).map((p) =>
      Object.assign({}, p, { path: photoPath(p.id) }));

    const files = [{ path: mp, b64: strToBase64(JSON.stringify(bundle)) }];

    let skipped = 0;
    if (scope === "full") {
      let known = new Set();
      try {
        const tr = await api("GET",
          `/repos/${S.owner}/${S.repo}/git/trees/${S.branch}?recursive=1`);
        known = new Set((tr.tree || []).map((x) => x.path));
      } catch (e) { /* 读不到就全量传 */ }
      for (const p of photos) {
        const pth = photoPath(p.id);
        if (known.has(pth)) { skipped++; continue; }   // 照片一经上传不再变动
        files.push({ path: pth, b64: await blobToBase64(p.blob) });
      }
    } else {
      bundle.photos = [];
      files[0].b64 = strToBase64(JSON.stringify(bundle));
    }
    log(`打包完成：元数据 + ${files.length - 1} 张新照片` + (skipped ? `（跳过 ${skipped} 张已上传）` : ""));

    const ref = await api("GET", `/repos/${S.owner}/${S.repo}/git/ref/heads/${S.branch}`);
    const parentSha = ref.object.sha;
    const parent = await api("GET", `/repos/${S.owner}/${S.repo}/git/commits/${parentSha}`);

    const tree = [];
    for (const f of files) {
      const b = await api("POST", `/repos/${S.owner}/${S.repo}/git/blobs`,
        { content: f.b64, encoding: "base64" });
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: b.sha });
      f.b64 = null;                                    // 边传边释放内存
    }
    const t = await api("POST", `/repos/${S.owner}/${S.repo}/git/trees`,
      { base_tree: parent.tree.sha, tree });
    const label = FR.fair ? (FR.fair.name || FR.fair.nameEn || FR.fair.id.slice(0, 8)) : "";
    const c = await api("POST", `/repos/${S.owner}/${S.repo}/git/commits`, {
      message: `FairRecorder backup — ${label} — ${new Date().toISOString()} — `
        + `${bundle.export.counts.suppliers} suppliers, ${files.length - 1} photos`
        + (scope === "full" ? "" : " (metadata only)"),
      tree: t.sha, parents: [parentSha],
    });
    await api("PATCH", `/repos/${S.owner}/${S.repo}/git/refs/heads/${S.branch}`, { sha: c.sha });

    S.lastSyncAt = new Date().toISOString();
    await saveCfg();
    await FR.markPushed(S.lastSyncAt);
    return { files: files.length, photos: files.length - 1, skipped, sha: c.sha.slice(0, 7) };
  }

  // ------------------------------------------------------------------- 拉取
  async function pull() {
    if (!configured()) throw new Error("请先填写 owner / repo / token");
    const mp = metaPath();
    const tr = await api("GET", `/repos/${S.owner}/${S.repo}/git/trees/${S.branch}?recursive=1`);
    const entry = (tr.tree || []).find((x) => x.path === mp);
    if (!entry) throw new Error("云端没有 " + mp + "，请先备份一次");

    const meta = await api("GET", `/repos/${S.owner}/${S.repo}/git/blobs/${entry.sha}`);
    const data = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(meta.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0))));

    // 云端展会若本机没有就先建出来
    if (data.fair && data.fair.id) {
      const known = await FR.all("fairs");
      if (!known.some((f) => f.id === data.fair.id)) {
        await FR.put("fairs", Object.assign({
          id: data.fair.id, name: data.fair.name || "", nameEn: data.fair.nameEn || "",
          city: "", venue: "", area: "", phase: data.fair.phase || "", startDate: "", endDate: "",
          defaultHall: "A区", notes: "", archived: false, lastPushAt: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
        }, data.fair));
      }
    }

    let ns = 0, nv = 0, np = 0;
    for (const s of data.suppliers || []) {
      const cur = await FR.get("suppliers", s.id);
      if (!cur || new Date(s.updatedAt) > new Date(cur.updatedAt)) { await FR.put("suppliers", s); ns++; }
    }
    for (const p of data.visitPlans || []) {
      const cur = await FR.get("visitPlans", p.id);
      if (!cur || new Date(p.updatedAt) > new Date(cur.updatedAt)) { await FR.put("visitPlans", p); nv++; }
    }
    const known = new Set((tr.tree || []).map((x) => x.path));
    for (const pm of data.photos || []) {
      const cur = await FR.get("photos", pm.id);
      if (cur) continue;
      const p = pm.path || photoPath(pm.id);
      if (!known.has(p)) continue;
      const pe = (tr.tree || []).find((x) => x.path === p);
      const blobMeta = await api("GET", `/repos/${S.owner}/${S.repo}/git/blobs/${pe.sha}`);
      const blob = b64ToBlob(blobMeta.content, "image/jpeg");
      await FR.put("photos", {
        id: pm.id, fairId: FR.fair ? FR.fair.id : null, supplierId: pm.supplierId,
        type: pm.type || "other", blob, thumbBlob: await FR.compress(blob, 320, 0.7),
        size: blob.size, sha256: pm.sha256 || "", createdAt: pm.createdAt || new Date().toISOString(),
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
      const tr = await api("GET", `/repos/${S.owner}/${S.repo}/git/trees/${S.branch}?recursive=1`);
      const entry = (tr.tree || []).find((x) => x.path === metaPath());
      if (!entry) return "无本展会备份";
      const meta = await api("GET", `/repos/${S.owner}/${S.repo}/git/blobs/${entry.sha}`);
      const data = JSON.parse(new TextDecoder().decode(
        Uint8Array.from(atob(meta.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0))));
      return `${(data.suppliers || []).length} 条 · ${(data.photos || []).length} 张照片`;
    } catch (e) {
      return "读取失败：" + e.message;
    }
  }

  // --------------------------------------------------------------------- UI
  async function renderStatus() {
    const pend = FR.pendingChanges();
    $("#syPending").textContent = pend ? `${pend} 条待上传` : "无（本地与云端一致）";
    $("#syPending").style.color = pend ? "var(--warn)" : "var(--accent)";
    $("#syLocal").textContent = `${FR.suppliers.length} 条 / ${FR.photos.length} 张`;
    $("#syLast").textContent = S.lastSyncAt ? new Date(S.lastSyncAt).toLocaleString("zh-CN") : "从未";
    $("#syFair").textContent = FR.fair
      ? `${FR.fair.name || FR.fair.nameEn || "（未命名）"} · ${fairRoot()}` : "未选择展会";
    const vis = $("#syVis");
    if (vis) {
      vis.textContent = S.repoPrivate === true ? "私有 ✅ 可备份"
        : S.repoPrivate === false ? "公开 ⚠️ 已禁止上传"
        : (configured() ? "未校验" : "未配置");
      vis.style.color = S.repoPrivate === true ? "var(--accent)"
        : S.repoPrivate === false ? "var(--danger)" : "var(--muted)";
    }
    $("#syRemote").textContent = configured() && FR.fair ? "读取中…" : "未配置";
    if (configured() && FR.fair) remoteCount().then((r) => { $("#syRemote").textContent = r; });
  }

  window.renderSync = async function () {
    await loadCfg();
    const set = (id, v) => { const el = $(id); if (el) el.value = v || ""; };
    set("#syOwner", S.owner); set("#syRepo", S.repo); set("#syBranch", S.branch);
    set("#syRoot", S.root); set("#syToken", S.token);

    const chip = (group, val) => {
      $$(`#${group} .chip`).forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.v === val)));
    };
    chip("syScope", S.scope);
    chip("syAuto", S.autoMode);
    chip("syAutoScope", S.autoScope);

    await renderStatus();

    $$("#syScope .chip").forEach((b) => {
      b.onclick = () => { S.scope = b.dataset.v; chip("syScope", S.scope); };
    });
    $$("#syAuto .chip").forEach((b) => {
      b.onclick = async () => { S.autoMode = b.dataset.v; chip("syAuto", S.autoMode); await saveCfg();
        log("自动备份：" + b.textContent); };
    });
    $$("#syAutoScope .chip").forEach((b) => {
      b.onclick = async () => { S.autoScope = b.dataset.v; chip("syAutoScope", S.autoScope); await saveCfg(); };
    });

    $("#sySave").onclick = async () => {
      S.owner = $("#syOwner").value.trim();
      S.repo = $("#syRepo").value.trim();
      S.branch = $("#syBranch").value.trim() || "main";
      S.root = $("#syRoot").value.trim() || "fairs";
      S.token = $("#syToken").value.trim();
      S.repoPrivate = null;                       // 换仓库后必须重新校验
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

    $("#syPush").onclick = async () => {
      try {
        log("开始备份（" + (S.scope === "full" ? "元数据 + 原图" : "仅元数据") + "）…");
        const r = await push(S.scope);
        log(`备份完成：${r.files} 个文件（新照片 ${r.photos}，跳过 ${r.skipped}），commit ${r.sha}`);
        FR.toast("备份完成", 4000);
        await renderStatus();
      } catch (e) { log("备份失败：" + e.message); FR.toast("备份失败：" + e.message, 5000); }
    };

    $("#syPushFull").onclick = async () => {
      try {
        log("开始备份（元数据 + 原图，流量大）…");
        const r = await push("full");
        log(`备份完成：${r.files} 个文件（新照片 ${r.photos}），commit ${r.sha}`);
        FR.toast("备份完成", 4000);
        await renderStatus();
      } catch (e) { log("备份失败：" + e.message); FR.toast("备份失败：" + e.message, 5000); }
    };

    $("#syPull").onclick = async () => {
      try {
        if (!confirm("从云端恢复到本展会：只覆盖云端更新的版本，本机较新的记录不会被覆盖。继续？")) return;
        log("开始拉取…");
        const r = await pull();
        log(`拉取完成：记录 ${r.suppliers} / 计划 ${r.plans} / 照片 ${r.photos}（云端共 ${r.remote} 条）`);
        FR.toast("恢复完成", 4000);
        await renderStatus();
      } catch (e) { log("拉取失败：" + e.message); FR.toast("拉取失败：" + e.message, 5000); }
    };
  };

  /* 供自动备份定时器调用 */
  window.FRSync = {
    push, pull, ready, testConnection,
    async pushIfPending(scope) {
      if (!ready()) return null;
      if (FR.pendingChanges() === 0) return null;
      return push(scope || S.autoScope || "meta");
    },
  };
})();
