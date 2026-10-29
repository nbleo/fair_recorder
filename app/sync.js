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

  /* 单个请求的上限。不设超时的话，链路被黑洞时手机浏览器会挂好几分钟
   * （iOS Safari 尤其久），用户只会看到"一直转圈"，分不清是慢还是不通。 */
  const NET_TIMEOUT_MS = 30000;

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

  /* ============================ 输入的脏字符 ============================ */

  /* 从 GitHub 网页、微信、备忘录里复制 token 时常会带上零宽字符、全角空格、换行。
   * 这些字符肉眼看不出，却会让 fetch 在请求发出去之前就抛
   * "String contains non ISO-8859-1 code point"，上层再包装成"网络不可达"，
   * 于是用户以为是信号不好，换 Wi-Fi、开关飞行模式，反复重试永远失败。
   * 落库前统一洗掉：HTTP 头的值本来也不允许出现这些字符。 */
  function cleanToken(v) {
    return String(v == null ? "" : v)
      .replace(/[\u200B-\u200F\u2028\u2029\uFEFF\u00A0]/g, "")  // 零宽 / BOM / 不换行空格
      .replace(/\s+/g, "");                                     // 换行、制表、普通空格
  }

  /* 找一个不能进 HTTP 头的字符（非可打印 ASCII），返回它本身，没有则返回空串 */
  function badChar(v) {
    const m = String(v == null ? "" : v).match(/[^\x20-\x7E]/);
    return m ? m[0] : "";
  }
  function charName(ch) {
    return JSON.stringify(ch) + " (U+"
      + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0") + ")";
  }

  /* 把底层异常翻译成用户能照着做的判断。笼统的"网络不可达"会让人在信号、
   * Wi-Fi、飞行模式之间瞎试，而真正的原因可能是 token 里混了一个零宽字符。 */
  function netError(e, timedOut) {
    const raw = String((e && e.message) || e || "unknown");
    if (/non ISO-8859-1|Invalid value|ByteString/i.test(raw)) {
      return new Error("Blocked before the request left the phone: a saved value contains "
        + "characters that are not allowed in an HTTP header. Clear the token field and paste it again.");
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return new Error("This device is offline — the browser reports no network. "
        + "Turn on Wi-Fi or mobile data and try again.");
    }
    if (timedOut) {
      return new Error("api.github.com gave no answer within " + Math.round(NET_TIMEOUT_MS / 1000)
        + "s, so this network is most likely blocking or throttling it. "
        + "Open https://api.github.com/ in the phone browser: if it does not show JSON, "
        + "switch networks or use a VPN. Your notes are safe on the phone either way.");
    }
    return new Error("Cannot reach api.github.com (" + raw + "). "
      + "Open https://api.github.com/ in the phone browser to see whether this network can reach GitHub at all.");
  }

  /* toast 只有一行，长句会被挤成一坨看不清。完整原因留在日志区，这里只取第一句。 */
  function shortErr(msg) {
    const s = String(msg || "");
    const m = s.match(/^.*?[.!?](?:\s|$)/);
    const one = (m ? m[0] : s).trim();
    return one.length > 90 ? one.slice(0, 88) + "…" : one;
  }

  /* ============================ 配置 ============================ */

  async function loadCfg() {
    const saved = await FR.getKV("gh", null);
    S = Object.assign({}, DEFAULTS, saved || {});
    /* 旧版本保存的 token 可能已经带了不可见字符。读出来顺手洗掉，
     * 否则用户点了"测试连接"还是失败，会以为这个问题修不好。 */
    if (S.token) S.token = cleanToken(S.token);
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
    if (!w) throw new Error("Visitor identity unknown: tap Test connection in Cloud backup, or fill in the namespace manually");
    return `${(S.root || "users").replace(/^\/+|\/+$/g, "")}/${w}`;
  }
  function fairRoot() {
    const f = FR.fair;
    if (!f) throw new Error("No fair selected");
    return `${userRoot()}/fairs/${f.id}`;
  }
  function metaPath() { return `${fairRoot()}/meta.json`; }
  /* 指定展会的 meta 路径——删除展会时当前展会已经不存在了，必须能按 id 拼出来 */
  function metaPathOf(fairId) { return `${userRoot()}/fairs/${fairId}/meta.json`; }
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

  async function api(method, url, body, signal, opts) {
    /* 先把配置里的脏字符拦掉。放任它走到 fetch，只会得到一句
     * "Failed to fetch"，用户没法知道是 token 的问题而不是信号。 */
    const badTk = badChar(S.token);
    if (badTk) {
      throw new Error("The saved token contains an invisible or non-ASCII character "
        + charName(badTk) + ", which cannot be sent in a request header. "
        + "Clear the token field and paste the token again (typing it never helps — the character is invisible).");
    }
    const badRepo = badChar(S.owner) || badChar(S.repo) || badChar(S.branch);
    if (badRepo) {
      throw new Error("Owner / repository / branch contains an invalid character " + charName(badRepo)
        + ". Use only letters, digits, hyphen, underscore and dot.");
    }
    if (!S.token) throw new Error("Token is empty — paste a fine-grained token with Contents: Read and write");

    const headers = {
      Authorization: "Bearer " + S.token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    /* 注意：不要加 Cache-Control / Pragma 之类的自定义请求头——GitHub 的 CORS
     * 预检不允许这些字段，浏览器会直接拦掉所有请求。破缓存改用下面的时间戳参数。 */
    if (body) headers["Content-Type"] = "application/json";
    /* 刚写完就读 ref / tree 时，GitHub 的边缘节点可能返回上一版副本，
     * 会让下一次提交 422 "Update is not a fast forward"。
     * GitHub 忽略未知查询参数，但会因此绕过 CDN 副本。 */
    const url2 = method === "GET"
      ? url + (url.includes("?") ? "&" : "?") + "_=" + Date.now() : url;
    const outer = signal || (_ctrl && _ctrl.signal) || null;
    /* 展馆里网络抖动是常态。GET 是只读的，重试安全；写请求不重试，避免重复提交。 */
    let res;
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      let timedOut = false;
      const onAbort = () => ctl.abort();
      if (outer) {
        if (outer.aborted) ctl.abort();
        else outer.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, NET_TIMEOUT_MS);
      try {
        res = await fetch("https://api.github.com" + url2, {
          method, headers, body: body ? JSON.stringify(body) : undefined,
          signal: ctl.signal,
        });
        break;
      } catch (e) {
        /* 用户主动取消（新的同步顶掉旧的）原样上抛，不要伪装成网络故障 */
        if (outer && outer.aborted) throw e;
        /* 超时不重试：链路被黑洞时重试只会把 30s 拉成 90s，用户更难受 */
        if (timedOut || method !== "GET" || attempt >= 2) throw netError(e, timedOut);
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
        if (outer) outer.removeEventListener("abort", onAbort);
      }
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
      /* 1) blob 只传一次：照片最大的开销在这里，重试时不必重传 */
      const blobs = [];
      for (const f of files) {
        const b = await api("POST", `/repos/${S.owner}/${S.repo}/git/blobs`,
          { content: f.b64, encoding: "base64" });
        blobs.push({ path: f.path, mode: "100644", type: "blob", sha: b.sha });
        f.b64 = null;                                   // 边传边释放内存
      }

      /* 2) 提交。读到的 ref 可能是旧副本（CDN 一致性）或期间被别的设备推进过，
       *    PATCH 会 422 "Update is not a fast forward"。
       *    用最新的 ref 重建 tree/commit 再提交即可——blob 已上传，重试很便宜。 */
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const ref = await api("GET", `/repos/${S.owner}/${S.repo}/git/ref/heads/${S.branch}`);
          const parentSha = ref.object.sha;
          const parent = await api("GET", `/repos/${S.owner}/${S.repo}/git/commits/${parentSha}`);
          const t = await api("POST", `/repos/${S.owner}/${S.repo}/git/trees`,
            { base_tree: parent.tree.sha, tree: blobs });
          const c = await api("POST", `/repos/${S.owner}/${S.repo}/git/commits`,
            { message, tree: t.sha, parents: [parentSha] });
          await api("PATCH", `/repos/${S.owner}/${S.repo}/git/refs/heads/${S.branch}`,
            { sha: c.sha });
          return c.sha;
        } catch (e) {
          if (!/422/.test(String((e && e.message) || ""))) throw e;
          lastErr = e;
          log(`Submit hit a conflict (attempt ${attempt + 1}); re-reading progress and retrying...`);
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      throw lastErr || new Error("Submit failed: could not advance the branch");
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
    if (!pass) throw new Error("Cloud encryption is on: enter the passphrase (if it is lost the cloud copy cannot be recovered)");
    const salt = (remoteMeta && remoteMeta.enc && remoteMeta.enc.salt) || newSaltB64();
    return { key: await deriveKey(pass, salt), salt, enc: Object.assign({}, ENC, { salt }) };
  }

  /* ============================ 安全校验 ============================ */

  async function assertSafe() {
    const hit = PUBLIC_CODE_REPOS.find((c) =>
      c.owner.toLowerCase() === String(S.owner).toLowerCase()
      && c.repo.toLowerCase() === String(S.repo).toLowerCase());
    if (hit) {
      throw new Error(`"${hit.owner}/${hit.repo}" is the public app repository (Pages site) — `
        + "code only. Point factory data at a private repository.");
    }
    const r = await api("GET", `/repos/${S.owner}/${S.repo}`);
    S.repoPrivate = !!r.private;
    await saveCfg();
    if (!r.private) {
      throw new Error(`"${r.full_name}" is a public repository, upload refused. Make it private in `
        + "Settings or create a private one — factory lists and photos must never go into a public repo.");
    }
    return r;
  }

  /* 身份：默认用 GitHub 登录名。用户填完配置直接点「立即备份」、
   * 从没点过「测试连接」时，这里补一次，否则命名空间为空无法写云端 */
  async function ensureIdentity() {
    if (S.login) return S.login;
    try {
      const u = await Syncer.getUserInfo();
      S.login = u.login;
      await saveCfg();
    } catch (e) { /* 读不到就回落到手填的命名空间 */ }
    return S.login;
  }

  async function testConnection() {
    if (!configured()) throw new Error("Fill in owner / repo / token first");
    const r = await api("GET", `/repos/${S.owner}/${S.repo}`);
    S.repoPrivate = !!r.private;
    let whoTxt = "identity unknown";
    try {
      const u = await Syncer.getUserInfo();
      S.login = u.login;
      whoTxt = u.login;
    } catch (e) {
      whoTxt = "identity unreadable (use the namespace field below)";
    }
    await saveCfg();
    const vis = r.private ? "private OK" : "PUBLIC (upload blocked)";
    return `${r.full_name} · ${vis} · branch ${r.default_branch} · visitor ${whoTxt}`;
  }

  /* 一键体检：把笼统的"网络不可达"拆成几条能自己判断的结论。
   * 手机上没法开控制台，所以每条结果都写进备份日志区，用户截图就能说明问题。 */
  async function diagnose() {
    const say = (s) => { log("Diagnose · " + s); return s; };
    const conn = navigator.connection || navigator.mozConnection || {};
    say("Device: " + (navigator.onLine ? "browser reports ONLINE" : "browser reports OFFLINE")
      + (conn.effectiveType ? " · link " + conn.effectiveType : "")
      + (conn.downlink ? " · ~" + conn.downlink + " Mbps" : "")
      + (conn.rtt ? " · rtt " + conn.rtt + " ms" : ""));

    /* 1) 只验证能不能建立 TCP+TLS 到 api.github.com。no-cors 既不触发预检，
     *    也不要求响应带 CORS 头，所以"失败"就一定是链路问题，与 CORS 无关。 */
    let reachable = false;
    const t1 = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      /* 不读响应内容：全不透明响应读不了，但能拿到就说明连接已经建立 */
      await fetch("https://api.github.com/zen?_=" + Date.now(), {
        mode: "no-cors", cache: "no-store", signal: ctl.signal,
      });
      clearTimeout(timer);
      reachable = true;
      say("api.github.com reachable (" + (Date.now() - t1) + " ms)");
    } catch (e) {
      say("api.github.com UNREACHABLE — " + ((e && e.message) || e)
        + ". This is the network, not the app: try another Wi-Fi / mobile data, or a VPN.");
    }

    /* 2) 链路通了再看 CORS / HTTP 是否放行。这一步才需要读正文。 */
    if (reachable) {
      try {
        const r = await fetch("https://api.github.com/zen?_=" + Date.now(), { cache: "no-store" });
        const txt = await r.text();
        say("HTTP + CORS ok (status " + r.status + ", " + txt.length + " chars back)");
      } catch (e) {
        say("Reached GitHub but the response was blocked: " + ((e && e.message) || e));
      }
    }

    /* 3) token 本身的字符状态。只报长度和前缀类型，绝不整串打印。 */
    const bad = badChar(S.token);
    say("Token: " + (S.token
      ? S.token.length + " chars, prefix " + S.token.slice(0, 11) + "…"
        + (bad ? " · ILLEGAL character " + charName(bad) + " → re-paste it" : " · all ASCII, ok")
      : "EMPTY → paste a token"));

    /* 4) 仓库 / 身份配置，避免把 401/404 当成网络问题。 */
    say("Target: " + (S.owner || "(no owner)") + "/" + (S.repo || "(no repo)")
      + " · branch " + (S.branch || "main") + " · identity " + (who() || "(unknown)"));

    return reachable;
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
    if (!configured()) throw new Error("Fill in owner / repo / token first");
    await assertSafe();
    await ensureIdentity();
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
              phase: fair.phase || "", startDate: fair.startDate || "", endDate: fair.endDate || "",
              /* 墓碑：非空表示这个展会被删了，其他设备拉取时跟着删 */
              deletedAt: fair.deletedAt || null },
      updatedAt: new Date().toISOString(),
      counts: {
        suppliers: bundle.export.counts.suppliers,
        photos: (bundle.photos || []).length,
        plans: (bundle.visitPlans || []).length,
        tombstones: bundle.export.counts.tombstones,
      },
      chunks: chunks.map((c) => ({ path: c.path, start: c.start, count: c.items.length })),
      /* 照片必须带上归属，否则从云端拉回来后无法对应到具体厂家 */
      uploadedPhotos: scope === "full" ? (bundle.photos || []).map((p) => ({
        path: assetPath(p.id), id: p.id, supplierId: p.supplierId || null,
        type: p.type || "other", size: p.size || 0, createdAt: p.createdAt || "",
      })) : null,
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
    log(`${chunks.length} chunk(s); uploading ${dirty.size} dirty chunk(s) / ${newPhotos} new photo(s)`
      + (skipped ? ` (${skipped} already uploaded, skipped)` : ""));
    return { files: files.length, chunks: dirty.size, photos: newPhotos, skipped, sha: sha.slice(0, 7) };
  }

  /* ============================ 展会删除（墓碑） ============================
     本机删除展会后，必须往云端写一条 meta.fair.deletedAt，否则别的设备下次
     拉取时又把这个展会原样拉回来——删了等于没删。
     墓碑 meta 很小：只带 id / 名称 / 删除时间，不带任何业务数据。 */
  async function pushTombstone(fairId) {
    if (!configured()) throw new Error("Fill in owner / repo / token first");
    await assertSafe();
    await ensureIdentity();
    const f = await FR.get("fairs", fairId);
    if (!f) throw new Error("This fair does not exist on this device");
    const mp = metaPathOf(fairId);
    const meta = {
      layout: LAYOUT, app: "FairRecorder", user: who(),
      fair: { id: fairId, name: f.name || "", nameEn: f.nameEn || "",
              phase: f.phase || "", startDate: f.startDate || "", endDate: f.endDate || "",
              deletedAt: f.deletedAt || new Date().toISOString() },
      updatedAt: new Date().toISOString(),
      counts: { suppliers: 0, photos: 0, plans: 0, tombstones: 0 },
      chunks: [], uploadedPhotos: null, weights: null,
      encrypted: false, enc: null, deleted: true,
    };
    const sha = await Syncer.uploadContent(
      [{ path: mp, b64: strToBase64(JSON.stringify(meta)) }],
      `FairRecorder delete — ${who()} — ${f.name || fairId.slice(0, 8)} — tombstone`);
    return { files: 1, sha: sha.slice(0, 7) };
  }

  /* 收到云端墓碑：在本机执行同一套删除（不再弹确认——用户在删的那台设备上已经确认过） */
  async function applyRemoteDeletion(fairId, meta) {
    if (!FR.deleteFairLocal) throw new Error("This device runs an older build without fair deletion — reload the page");
    const r = await FR.deleteFairLocal(fairId, (meta && meta.fair && meta.fair.deletedAt) || null);
    return { deleted: true, id: fairId, name: r.name || fairId,
             suppliers: r.suppliers || 0, plans: r.plans || 0, photos: r.photos || 0 };
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
    if (!configured()) throw new Error("Fill in owner / repo / token first");
    if (!FR.fair) throw new Error("No fair selected");
    await ensureIdentity();

    const st = await Syncer.fetchStructure();
    const meta = await readMeta(st);
    if (!meta) {
      /* 最常见的原因：这台设备的展会是自己新建的，UUID 和电脑端那个不一样，
       * 于是按 ID 精确匹配永远落空。只说「没有备份」会让人以为数据丢了——
       * 把云端真实存在的展会列出来，并指明该用哪个按钮。 */
      let hint = "";
      try {
        const list = await listRemoteFairs();
        if (list.length) {
          hint = " The cloud holds " + list.length + " fair(s): "
            + list.map((f) => f.name + " (" + f.suppliers + " records)").join(", ")
            + ". Use Pull all fairs from cloud — it brings the fair and its records here, "
            + "no need to create the same fair on both sides first.";
        }
      } catch (e) { /* 列不出来就不附加提示 */ }
      throw new Error("No cloud backup of this fair (" + (FR.fair.name || FR.fair.id) + ")." + hint);
    }

    /* 旧版布局：直接是一整个 bundle */
    if (meta.layout === LEGACY_LAYOUT) {
      const data = meta.__legacy;
      await ensureFair(data.fair);
      return applyBundle(data, st, null);
    }

    /* 新版布局 */
    /* 云端说这个展会已经被删了：本机跟着删，别再把它拉回来 */
    if (meta.fair && meta.fair.deletedAt) {
      return applyRemoteDeletion(FR.fair ? FR.fair.id : null, meta);
    }
    await ensureFair(meta.fair);
    let key = null;
    if (meta.encrypted) {
      const pass = ($("#syPass") && $("#syPass").value) || "";
      if (!pass) throw new Error("The cloud copy is encrypted — enter the passphrase above before restoring");
      if (!meta.enc || !meta.enc.salt) throw new Error("Encryption parameters are missing in the cloud; cannot decrypt");
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

    /* 评分权重也随云端走：多设备之间保持一致 */
    if (meta.weights && FR.setWeights) await FR.setWeights(meta.weights);

    const bundle = {
      suppliers,
      visitPlans: [],
      photos: cloudPhotos(meta),
    };
    return applyBundle(bundle, st, key, FR.fair ? FR.fair.id : null, true);
  }

  /* uploadedPhotos 有两种写法：新版本是带归属的对象，旧版本只是路径字符串 */
  function cloudPhotos(meta) {
    return (meta.uploadedPhotos || []).map((p) => (typeof p === "string"
      ? { id: p.split("/").pop().replace(/\.jpg$/, ""), path: p,
          supplierId: null, type: "other", createdAt: "" }
      : { id: p.id, path: p.path, supplierId: p.supplierId || null,
          type: p.type || "other", createdAt: p.createdAt || "" }));
  }

  /* ======================= 多终端：列出 / 拉取 / 全量 ======================= */

  /* 云端某个人的全部展会——新设备靠它发现"我有哪些展会" */
  async function listRemoteFairs() {
    if (!configured()) throw new Error("Fill in owner / repo / token first");
    await ensureIdentity();
    const st = await Syncer.fetchStructure();
    const base = `${userRoot()}/fairs/`;
    const out = [];
    for (const e of st.prefix(base)) {
      if (!e.path.endsWith("/meta.json")) continue;
      const id = e.path.slice(base.length).split("/")[0];
      try {
        const m = JSON.parse(await Syncer.fetchContent(e, true));
        if (m.layout === LEGACY_LAYOUT) {          // 旧版单文件布局
          out.push({ id, name: (m.fair && (m.fair.name || m.fair.nameEn)) || id,
            nameEn: "", dates: "", suppliers: (m.suppliers || []).length, photos: 0,
            updatedAt: "", encrypted: false, legacy: true });
          continue;
        }
        const f = m.fair || {};
        out.push({
          id,
          name: f.name || f.nameEn || id,
          nameEn: f.nameEn || "",
          deleted: !!(f.deletedAt || m.deleted),
          dates: [f.startDate, f.endDate].filter(Boolean).join(" → "),
          suppliers: (m.counts && m.counts.suppliers) || 0,
          photos: (m.counts && m.counts.photos) || 0,
          updatedAt: m.updatedAt || "",
          encrypted: !!m.encrypted,
        });
      } catch (err) { /* 单个展会读不动不拖累整体 */ }
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }

  /* 拉取指定展会（不依赖当前选中的展会，供全量拉取复用） */
  async function pullFair(fairId, opts) {
    if (!configured()) throw new Error("Fill in owner / repo / token first");
    await ensureIdentity();
    const wantPhotos = !opts || opts.photos !== false;
    const st = await Syncer.fetchStructure();
    const base = `${userRoot()}/fairs/${fairId}`;
    const me = st.find(`${base}/meta.json`);
    if (!me) throw new Error("No cloud backup of this fair");
    const meta = JSON.parse(await Syncer.fetchContent(me, true));

    if (meta.layout === LEGACY_LAYOUT) {
      const data = meta.__legacy || {};
      await ensureFair(Object.assign({ id: fairId }, data.fair || {}));
      return applyBundle(data, st, null, fairId, wantPhotos);
    }

    /* 墓碑：这台设备上的同名展会也要删掉 */
    if (meta.fair && meta.fair.deletedAt) {
      return applyRemoteDeletion(fairId, meta);
    }

    let key = null;
    if (meta.encrypted) {
      const pass = ($("#syPass") && $("#syPass").value) || "";
      if (!pass) throw new Error("The cloud copy is encrypted — enter the passphrase before pulling");
      if (!meta.enc || !meta.enc.salt) throw new Error("Encryption parameters are missing in the cloud; cannot decrypt");
      key = await deriveKey(pass, meta.enc.salt);
    }

    const suppliers = [];
    for (const c of meta.chunks || []) {
      const e = st.find(c.path);
      if (!e) continue;
      const parsed = JSON.parse(await Syncer.fetchContent(e, true));
      const payload = (parsed && parsed.enc === 1) ? await decJSON(parsed, key) : parsed;
      for (const s of payload.items || []) suppliers.push(s);
    }
    if (meta.weights && FR.setWeights) await FR.setWeights(meta.weights);
    await ensureFair(Object.assign({ id: fairId }, meta.fair || {}));
    const r = await applyBundle({ suppliers, visitPlans: [], photos: cloudPhotos(meta) },
      st, key, fairId, wantPhotos);
    return Object.assign({ id: fairId, name: (meta.fair && (meta.fair.name || meta.fair.nameEn)) || fairId }, r);
  }

  /* 拉取云端所有展会——换设备后的第一步 */
  async function pullAll(opts) {
    const list = await listRemoteFairs();
    const out = [];
    for (const f of list) {
      /* 已删除的展会也要走一遍 pullFair：那一趟会把它从本机删掉 */
      try {
        out.push(await pullFair(f.id, opts));
      } catch (e) {
        out.push({ id: f.id, name: f.name, error: e.message, suppliers: 0, plans: 0, photos: 0 });
      }
    }
    return out;
  }

  /* 把本机所有展会都备份一遍（不必逐个切换展会去点） */
  async function pushAll(scope) {
    const fairs = await FR.all("fairs");
    const cur = FR.fair ? FR.fair.id : null;
    const out = [];
    for (const f of fairs) {
      /* 墓碑优先：删掉的展会也要推一次，否则别的设备永远不知道它没了。
         已经推过墓碑（备份时间晚于删除时间）的就不用重复推。 */
      if (f.deletedAt) {
        if (f.lastPushAt && f.lastPushAt > f.deletedAt) continue;
        try {
          await pushTombstone(f.id);
          out.push({ id: f.id, name: f.name || f.nameEn || f.id, tombstone: true, files: 1 });
        } catch (e) {
          out.push({ id: f.id, name: f.name || f.id, error: e.message });
        }
        continue;
      }
      if (f.archived) continue;
      await FR.selectFair(f.id);
      try {
        out.push(Object.assign({ id: f.id, name: f.name || f.nameEn || f.id }, await push(scope)));
      } catch (e) {
        out.push({ id: f.id, name: f.name || f.id, error: e.message });
      }
    }
    if (cur) await FR.selectFair(cur);
    return out;
  }

  /* 双向同步：先拉云端较新的，再把本机较新的推上去 */
  async function syncNow(scope) {
    if (!FR.fair) throw new Error("Select a fair first");
    const out = { pulled: null, pushed: null };
    try {
      out.pulled = await pullFair(FR.fair.id, { photos: (scope || S.scope) === "full" });
    } catch (e) {
      if (!/does not exist on this device|No cloud backup of this fair/.test(e.message)) throw e;
      out.pulled = { skipped: "no cloud copy of this fair yet — going straight to upload" };
    }
    /* 拉下来的是墓碑：本机刚被删掉，这一步就到此为止，别再往回推 */
    if (out.pulled && out.pulled.deleted) return out;
    out.pushed = await push(scope || S.scope || "meta");
    return out;
  }

  async function ensureFair(f) {
    if (!f || !f.id) return;
    const known = await FR.all("fairs");
    if (known.some((x) => x.id === f.id)) return;
    await FR.put("fairs", Object.assign({
      id: f.id, name: "", nameEn: "", city: "", venue: "", area: "", phase: "",
      startDate: "", endDate: "", defaultHall: "Hall A", notes: "", archived: false,
      lastPushAt: null, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), deletedAt: null,
    }, f));
    await FR.refresh();
  }

  /* 云端 -> 本地：只覆盖云端更新的版本，本地较新的不动 */
  async function applyBundle(data, st, key, fairId, wantPhotos) {
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
    if (wantPhotos !== false) {
      for (const pm of data.photos || []) {
        const cur = await FR.get("photos", pm.id);
        if (cur) continue;
        const p = pm.path || assetPath(pm.id);
        const e = st.find(p);
        if (!e) continue;
        let blob = await Syncer.fetchContent(e, false);
        if (key) blob = await decBlob(blob, key);
        await FR.put("photos", {
          id: pm.id, fairId: fairId || (FR.fair ? FR.fair.id : null),
          supplierId: pm.supplierId,
          type: pm.type || "other", blob, thumbBlob: await FR.compress(blob, 320, 0.7),
          size: blob.size, sha256: pm.sha256 || "",
          createdAt: pm.createdAt || new Date().toISOString(),
        });
        np++;
      }
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
      if (!meta) return "No backup of this fair";
      if (meta.layout === LEGACY_LAYOUT) {
        const d = meta.__legacy;
        return `legacy layout · ${(d.suppliers || []).length} records · ${(d.photos || []).length} photos`;
      }
      const enc = meta.encrypted ? " · encrypted" : "";
      return `${meta.counts.suppliers} records · ${meta.counts.photos} photos · ${meta.chunks.length} chunks${enc}`;
    } catch (e) {
      return "Read failed: " + e.message;
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

  /* 列出云端展会并渲染到 #syRemoteList。
   * 保存配置成功后自动调一次——用户填完配置就该立刻看到"云端到底有没有东西"，
   * 而不是点完拉取才发现为空，然后怀疑是不是没同步上。 */
  async function showRemoteList() {
    const box = $("#syRemoteList");
    try {
      const list = await listRemoteFairs();
      if (box) {
        box.classList.remove("hide");
        box.innerHTML = "<b>Cloud fairs (" + list.length + ")</b><br>"
          + (list.length
            ? list.map((f) => esc(f.name)
              + (f.dates ? " · " + esc(f.dates) : "")
              + (f.deleted ? " · <b>deleted (tombstone)</b>" : " · " + f.suppliers + " records / " + f.photos + " photos")
              + (f.encrypted ? " · encrypted" : "")).join("<br>")
            : "<i>No fairs in the cloud yet</i>");
      }
      log(list.length
        ? list.length + " fair(s) in the cloud: " + list.map((f) => f.name).join(", ")
        : "No fairs in the cloud yet — they appear after the first backup from this device");
      return list;
    } catch (e) {
      if (box) {
        box.classList.remove("hide");
        box.innerHTML = "<i>Could not read the cloud fair list: " + esc(e.message) + "</i>";
      }
      log("Failed to read the cloud fair list: " + e.message);
      return [];
    }
  }

  async function renderStatus() {
    const pend = FR.pendingChanges();
    const set = (id, v, color) => {
      const el = $(id); if (!el) return;
      el.textContent = v; if (color) el.style.color = color;
    };
    set("#syPending", pend ? `${pend} pending` : "None (local and cloud match)",
      pend ? "var(--warn)" : "var(--accent)");
    set("#syLocal", `${FR.suppliers.length} records / ${FR.photos.length} photos`);
    set("#syLast", S.lastSyncAt ? new Date(S.lastSyncAt).toLocaleString("en-GB") : "Never");
    /* 把命名空间完整显示出来：「拉不到数据」的第二大原因就是身份没识别出来，
     * 于是读写的是 users//fairs/ 而不是 users/<登录名>/fairs/。让用户一眼能核对。 */
    const w = S.login || S.namespace || "";
    set("#syWho", w ? `${w} → ${(S.root || "users")}/${w}`
      : "Unknown — fill in the visitor namespace below",
      w ? undefined : "var(--danger)");
    try { set("#sySpace", FR.fair ? fairRoot() : "No fair selected"); }
    catch (e) { set("#sySpace", "Visitor identity required"); }
    set("#syFair", FR.fair ? (FR.fair.name || FR.fair.nameEn || "(untitled)") : "No fair selected");

    set("#syVis", S.repoPrivate === true ? "Private — backup allowed"
      : S.repoPrivate === false ? "Public — upload blocked"
      : (configured() ? "Not checked" : "Not configured"),
      S.repoPrivate === true ? "var(--accent)"
        : S.repoPrivate === false ? "var(--danger)" : "var(--muted)");

    set("#syCollab", "Loading...");
    set("#syRemote", configured() && FR.fair ? "Loading..." : "Not configured");
    if (configured() && FR.fair) {
      remoteCount().then((r) => set("#syRemote", r)).catch(() => set("#syRemote", "Read failed"));
      Syncer.getCollaborators().then((c) => {
        if (!c) { set("#syCollab", "Unreadable (token lacks permission)"); return; }
        set("#syCollab", c.length ? c.map((x) => x.login).join(", ") : "Repository owner only");
      });
    }
  }

  window.renderSync = async function () {
    await loadCfg();
    const set = (id, v) => { const el = $(id); if (el) el.value = v || ""; };
    set("#syOwner", S.owner); set("#syRepo", S.repo); set("#syBranch", S.branch);
    set("#syRoot", S.root); set("#syNamespace", S.namespace);
    /* token 不回填：同步页是常看的页面，手机临时借人、投屏、截屏时不该把
     * 一枚有写权限的 token 摆在那里。留空即表示"沿用已保存的那枚"。 */
    const tk = $("#syToken");
    if (tk) {
      tk.value = "";
      tk.placeholder = S.token ? "Saved (leave blank to keep)" : "github_pat_… / ghp_…";
    }

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
    bind("syAuto", async (v, txt) => { S.autoMode = v; await saveCfg(); log("Auto backup: " + txt); });
    bind("syAutoScope", async (v) => { S.autoScope = v; await saveCfg(); });
    bind("syEnc", async (v, txt) => {
      S.encrypt = v === "on";
      await saveCfg();
      log("Cloud encryption: " + txt + (S.encrypt ? " (remember the passphrase — it cannot be recovered)" : ""));
    });

    $("#sySave").onclick = async () => {
      S.owner = $("#syOwner").value.trim();
      S.repo = $("#syRepo").value.trim();
      S.branch = $("#syBranch").value.trim() || "main";
      S.root = $("#syRoot").value.trim() || "users";
      /* 留空 = 沿用已保存的 token。粘贴进来的值先洗掉换行与零宽字符：
       * 它们肉眼不可见，却会让请求在发出去之前就失败。 */
      const rawToken = $("#syToken").value;
      const typed = cleanToken(rawToken);
      if (typed) S.token = typed;
      if (typed && typed !== rawToken) {
        log("Token cleaned: removed " + (rawToken.length - typed.length)
          + " invisible/whitespace character(s) picked up while copying");
      }
      S.namespace = $("#syNamespace").value.trim();
      S.repoPrivate = null;                         // 换仓库后必须重新校验
      await saveCfg();
      log("Settings saved on this device");
      FR.toast("Saved");
      /* 保存后立刻校验一次：仓库是不是私有、我是谁，要让用户在保存的当下就看到，
       * 而不是等他点「立即备份」才发现填错了仓库或没识别出身份。 */
      if (configured()) {
        try {
          const r = await testConnection();
          log("Connected: " + r);
          /* 先把身份/可见性刷出来（本地读，瞬间），再去读云端清单（要走网络）。
           * 反过来会让用户干等好几秒才看到"我是谁"。 */
          try { await renderStatus(); } catch (e) { /* 不因状态刷新中断 */ }
          await showRemoteList();
        } catch (e) {
          log("Validation failed: " + e.message);
          FR.toast("Check the settings: " + shortErr(e.message) + " (details in the log below)", 7000);
        }
      }
      try { await renderStatus(); } catch (e) { log("Status refresh failed: " + e.message); }
    };

    $("#syTest").onclick = async () => {
      try {
        log("Testing connection...");
        const r = await testConnection();
        log("Connected: " + r);
        FR.toast("Connected", 3000);
        await renderStatus();
      } catch (e) {
        log("Connection failed: " + e.message);
        FR.toast("Connection failed: " + shortErr(e.message) + " (details in the log below)", 7000);
      }
    };

    /* 按钮可能不存在（HTML 与 JS 版本错配时），不能因此让整页初始化失败 */
    const diagBtn = $("#syDiag");
    if (diagBtn) diagBtn.onclick = async () => {
      FR.toast("Checking the network…", 2000);
      try {
        const ok = await diagnose();
        FR.toast(ok ? "api.github.com is reachable — check the log"
          : "api.github.com is unreachable — this is the network, not the app", 6000);
      } catch (e) {
        log("Diagnosis failed: " + e.message);
        FR.toast("Diagnosis failed: " + shortErr(e.message), 5000);
      }
    };

    const doPush = async (scope, label) => {
      try {
        log("Starting backup (" + label + ")...");
        const r = await Scheduler.run(() => push(scope));
        if (!r) return;                              // 被后来的请求顶掉
        log(`Backup done: ${r.files} file(s) (dirty chunks ${r.chunks}, new photos ${r.photos}, `
          + `skipped ${r.skipped}), commit ${r.sha}`);
        FR.toast("Backup done", 4000);
        await renderStatus();
      } catch (e) {
        if (e && e.name === "AbortError") { log("Backup cancelled (a newer sync request came in)"); return; }
        log("Backup failed: " + e.message);
        FR.toast("Backup failed: " + shortErr(e.message) + " (details in the log below)", 7000);
      }
    };
    $("#syPush").onclick = () => doPush(S.scope,
      S.scope === "full" ? "metadata + originals" : "metadata only");
    $("#syPushFull").onclick = () => doPush("full", "metadata + originals, heavy");

    $("#syPull").onclick = async () => {
      try {
        if (!FR.fair) {
          FR.toast("Pick a fair on the Fairs screen first. On a new device use Pull all fairs from cloud", 5000);
          return;
        }
        if (!confirm("Restore this fair from the cloud (" + (FR.fair.name || FR.fair.nameEn || FR.fair.id)
          + ")? Only newer cloud copies are applied; newer local records are kept. Continue?")) return;
        log("Starting pull...");
        const r = await Scheduler.run(() => pull());
        if (!r) return;
        if (r.deleted) {
          log(`"${r.name}" was deleted in the cloud — the local copy was removed too`
            + ` (records ${r.suppliers} / planned ${r.plans} / photos ${r.photos})`);
          FR.toast("This fair was deleted elsewhere; the local copy is gone too", 6000);
          await renderStatus();
          return;
        }
        log(`Pull done: records ${r.suppliers} / planned ${r.plans} / photos ${r.photos} (${r.remote} in the cloud)`);
        FR.toast("Restore done", 4000);
        await renderStatus();
      } catch (e) {
        if (e && e.name === "AbortError") { log("Pull cancelled"); return; }
        log("Pull failed: " + e.message); FR.toast("Pull failed: " + e.message, 5000);
      }
    };

    /* --- 双向同步：换设备后最常用的动作 --- */
    $("#sySync").onclick = async () => {
      try {
        if (!FR.fair) { FR.toast("Select a fair first", 4000); return; }
        const scope = S.scope || "meta";
        log(`Starting two-way sync (${scope === "full" ? "with originals" : "metadata only"})...`);
        const r = await Scheduler.run(() => syncNow(scope));
        if (!r) return;
        const p = r.pulled || {};
        if (p.skipped) log("Pull: " + p.skipped);
        else log(`Pull: records ${p.suppliers} / photos ${p.photos} (newer cloud copies merged)`);
        log(`Push: ${r.pushed.files} file(s) (dirty chunks ${r.pushed.chunks}, new photos ${r.pushed.photos}), commit ${r.pushed.sha}`);
        FR.toast("Two-way sync done", 4000);
        await renderStatus();
      } catch (e) {
        if (e && e.name === "AbortError") { log("Sync cancelled"); return; }
        log("Sync failed: " + e.message); FR.toast("Sync failed: " + e.message, 5000);
      }
    };

    /* --- 拉取云端全部展会（换设备后的第一步） --- */
    $("#syPullAll").onclick = async () => {
      try {
        log("Reading the cloud fair list...");
        const list = await Scheduler.run(() => showRemoteList());
        if (!list || !list.length) return;
        const withPhotos = confirm(
          "Pull " + list.length + " fair(s) from the cloud.\n\n"
          + "OK = include photos (more data)\nCancel = records and metadata only");
        log("Pulling all fairs (" + (withPhotos ? "with photos" : "records only") + ")...");
        const res = await Scheduler.run(() => pullAll({ photos: withPhotos }));
        if (!res) return;
        let ns = 0, np = 0, err = 0, nd = 0;
        for (const r of res) {
          if (r.error) { err++; log("  ✗ " + r.name + "：" + r.error); }
          else if (r.deleted) { nd++; log("  🗑 " + r.name + ": deleted in the cloud, local copy removed"); }
          else { ns += r.suppliers || 0; np += r.photos || 0; log("  ✓ " + r.name + ": records " + r.suppliers + " / photos " + r.photos); }
        }
        log(`All fairs pulled: ${ns} record(s) added or updated, ${np} photo(s)`
          + (nd ? `, ${nd} fair(s) deleted here too` : "") + (err ? `, ${err} failed` : ""));
        FR.toast("All fairs pulled", 4000);
        await renderStatus();
        if (ns || np) FR.toast("Fairs synced to this device — go back to Fairs to switch", 5000);
      } catch (e) {
        if (e && e.name === "AbortError") { log("Cancelled"); return; }
        log("Pull failed: " + e.message); FR.toast("Pull failed: " + e.message, 5000);
      }
    };

    /* --- 备份本机全部展会 --- */
    $("#syPushAll").onclick = async () => {
      try {
        const scope = S.scope || "meta";
        if (!confirm("Back up every active fair on this device (" + scope
          + (scope === "full" ? ", with originals" : ", metadata only") + "). Continue?")) return;
        log("Backing up all fairs...");
        const res = await Scheduler.run(() => pushAll(scope));
        if (!res) return;
        for (const r of res) {
          if (r.error) log("  ✗ " + r.name + "：" + r.error);
          else if (r.tombstone) log("  🗑 " + r.name + ": tombstone uploaded, other devices will delete it");
          else log("  ✓ " + r.name + ": " + r.files + " file(s), commit " + r.sha);
        }
        log("All fairs backed up (" + res.length + ")");
        FR.toast("All fairs backed up", 4000);
        await renderStatus();
      } catch (e) {
        if (e && e.name === "AbortError") { log("Cancelled"); return; }
        log("Backup failed: " + e.message);
        FR.toast("Backup failed: " + shortErr(e.message) + " (details in the log below)", 7000);
      }
    };

    $("#syInvite").onclick = () => {
      if (!configured()) { FR.toast("Fill in and save owner / repo first", 4000); return; }
      window.open(`https://github.com/${S.owner}/${S.repo}/settings/access`, "_blank");
      log("Opened the collaborator page: Settings → Collaborators → Add people");
    };
  };

  /* 供自动备份定时器调用 */
  window.FRSync = {
    push, pull, ready, testConnection, pushTombstone, diagnose,
    /* 多终端：发现云端展会 / 拉取单个 / 拉全部 / 推全部 / 双向同步 */
    listRemoteFairs, pullFair, pullAll, pushAll, syncNow,
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
