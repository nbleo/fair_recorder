/* FairRecorder — GitHub cloud backup.
 *
 * The phone's IndexedDB stays the primary copy; this module only pushes/pulls a
 * backup bundle to a private repository over the GitHub REST API.
 *
 * Photos are committed through the Git Data API (blobs -> tree -> commit -> ref)
 * instead of the Contents API, because the Contents API caps a single file at
 * 1 MB while a compressed phone photo is routinely several hundred KB.
 */
(function () {
  "use strict";

  const DEFAULTS = {
    owner: "", repo: "", branch: "main", path: "data/suppliers.json",
    token: "", scope: "full", lastSyncAt: null,
  };
  let S = Object.assign({}, DEFAULTS);
  const PHOTO_DIR = "data/photos";

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function log(msg) {
    const el = $("#syLog");
    if (!el) return;
    const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    el.innerHTML = `<div style="margin-bottom:4px"><b>${esc(t)}</b> ${esc(msg)}</div>` + el.innerHTML;
  }

  async function loadCfg() {
    const saved = await FR.getKV("gh", null);
    S = Object.assign({}, DEFAULTS, saved || {});
  }
  async function saveCfg() {
    await FR.setKV("gh", {
      owner: S.owner, repo: S.repo, branch: S.branch, path: S.path,
      token: S.token, scope: S.scope, lastSyncAt: S.lastSyncAt,
    });
  }

  function configured() {
    return !!(S.owner && S.repo && S.token);
  }

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
      } catch (e) { /* non-JSON body */ }
      throw new Error(res.status + " " + res.statusText + extra);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || "");
        resolve(s.slice(s.indexOf(",") + 1));
      };
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
    const bin = atob(b64.replace(/\n/g, ""));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || "image/jpeg" });
  }

  async function testConnection() {
    if (!configured()) throw new Error("请先填写 owner / repo / token");
    const r = await api("GET", `/repos/${S.owner}/${S.repo}`);
    const priv = r.private ? "私有" : "公开";
    return `${r.full_name}（${priv}）· 默认分支 ${r.default_branch}`;
  }

  // ------------------------------------------------------------------- push
  async function push(scope) {
    if (!configured()) throw new Error("请先填写 owner / repo / token");
    await FR.refresh();
    const { bundle, photos } = await FR.buildBundle("full");

    // Cloud layout differs from the ZIP layout: flat, id-based, no Chinese paths.
    bundle.photos = (bundle.photos || []).map((p) =>
      Object.assign({}, p, { path: `${PHOTO_DIR}/${p.id}.jpg` }));
    if (scope !== "full") bundle.photos = [];

    const files = [{ path: S.path, b64: strToBase64(JSON.stringify(bundle)) }];
    if (scope === "full") {
      for (const p of photos) {
        const b64 = await blobToBase64(p.blob);
        files.push({ path: `${PHOTO_DIR}/${p.id}.jpg`, b64 });
      }
    }
    log(`打包完成：${files.length} 个文件，开始上传…`);

    let ref;
    try {
      ref = await api("GET", `/repos/${S.owner}/${S.repo}/git/ref/heads/${S.branch}`);
    } catch (e) {
      throw new Error("读不到分支 " + S.branch + "：" + e.message);
    }
    const parentSha = ref.object.sha;
    const parent = await api("GET", `/repos/${S.owner}/${S.repo}/git/commits/${parentSha}`);

    const tree = [];
    for (const f of files) {
      const b = await api("POST", `/repos/${S.owner}/${S.repo}/git/blobs`,
        { content: f.b64, encoding: "base64" });
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: b.sha });
      f.b64 = null; // free memory as we go
    }
    const t = await api("POST", `/repos/${S.owner}/${S.repo}/git/trees`,
      { base_tree: parent.tree.sha, tree });
    const c = await api("POST", `/repos/${S.owner}/${S.repo}/git/commits`, {
      message: `FairRecorder backup ${new Date().toISOString()} — ` +
        `${bundle.export.counts.suppliers} suppliers, ${Math.max(0, files.length - 1)} photos`,
      tree: t.sha, parents: [parentSha],
    });
    await api("PATCH", `/repos/${S.owner}/${S.repo}/git/refs/heads/${S.branch}`, { sha: c.sha });

    S.lastSyncAt = new Date().toISOString();
    await saveCfg();
    return { files: files.length, photos: Math.max(0, files.length - 1), sha: c.sha.slice(0, 7) };
  }

  // ------------------------------------------------------------------- pull
  async function pull() {
    if (!configured()) throw new Error("请先填写 owner / repo / token");
    const tr = await api("GET",
      `/repos/${S.owner}/${S.repo}/git/trees/${S.branch}?recursive=1`);
    const entry = (tr.tree || []).find((x) => x.path === S.path);
    if (!entry) throw new Error("云端没有 " + S.path + "，请先上传一次");

    const meta = await api("GET", `/repos/${S.owner}/${S.repo}/git/blobs/${entry.sha}`);
    const data = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(meta.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0))));

    let ns = 0, nv = 0, np = 0;
    for (const s of data.suppliers || []) {
      const cur = await FR.get("suppliers", s.id);
      if (!cur || new Date(s.updatedAt) > new Date(cur.updatedAt)) {
        await FR.put("suppliers", s); ns++;
      }
    }
    for (const p of data.visitPlans || []) {
      const cur = await FR.get("visitPlans", p.id);
      if (!cur || new Date(p.updatedAt) > new Date(cur.updatedAt)) {
        await FR.put("visitPlans", p); nv++;
      }
    }
    const known = new Set((tr.tree || []).map((x) => x.path));
    for (const pm of data.photos || []) {
      const cur = await FR.get("photos", pm.id);
      if (cur) continue;
      const p = pm.path || `${PHOTO_DIR}/${pm.id}.jpg`;
      if (!known.has(p)) continue;
      const pe = (tr.tree || []).find((x) => x.path === p);
      const blobMeta = await api("GET", `/repos/${S.owner}/${S.repo}/git/blobs/${pe.sha}`);
      const blob = b64ToBlob(blobMeta.content, "image/jpeg");
      await FR.put("photos", {
        id: pm.id, supplierId: pm.supplierId, type: pm.type || "other",
        blob, thumbBlob: await FR.compress(blob, 320, 0.7),
        size: blob.size, sha256: pm.sha256 || "", createdAt: pm.createdAt || new Date().toISOString(),
      });
      np++;
    }
    await FR.refresh();
    S.lastSyncAt = new Date().toISOString();
    await saveCfg();
    return { suppliers: ns, plans: nv, photos: np, remote: (data.suppliers || []).length };
  }

  // --------------------------------------------------------------------- UI
  async function remoteCount() {
    try {
      const tr = await api("GET",
        `/repos/${S.owner}/${S.repo}/git/trees/${S.branch}?recursive=1`);
      const entry = (tr.tree || []).find((x) => x.path === S.path);
      if (!entry) return "无数据文件";
      const meta = await api("GET", `/repos/${S.owner}/${S.repo}/git/blobs/${entry.sha}`);
      const data = JSON.parse(new TextDecoder().decode(
        Uint8Array.from(atob(meta.content.replace(/\n/g, "")), (ch) => ch.charCodeAt(0))));
      return `${(data.suppliers || []).length} 条 · ${(data.photos || []).length} 张照片`;
    } catch (e) {
      return "读取失败：" + e.message;
    }
  }

  window.renderSync = async function () {
    await loadCfg();
    const set = (id, v) => { const el = $(id); if (el) el.value = v || ""; };
    set("#syOwner", S.owner); set("#syRepo", S.repo); set("#syBranch", S.branch);
    set("#syPath", S.path); set("#syToken", S.token);
    document.querySelectorAll("#syScope .chip").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.v === S.scope)));

    $("#syLast").textContent = S.lastSyncAt
      ? new Date(S.lastSyncAt).toLocaleString("zh-CN") : "从未";
    $("#syLocal").textContent = `${FR.suppliers.length} 条 / ${FR.photos.length} 张`;
    $("#syRemote").textContent = configured() ? "读取中…" : "未配置";

    document.querySelectorAll("#syScope .chip").forEach((b) => {
      b.onclick = () => {
        S.scope = b.dataset.v;
        document.querySelectorAll("#syScope .chip").forEach((x) =>
          x.setAttribute("aria-pressed", String(x === b)));
      };
    });

    $("#sySave").onclick = async () => {
      S.owner = $("#syOwner").value.trim();
      S.repo = $("#syRepo").value.trim();
      S.branch = $("#syBranch").value.trim() || "main";
      S.path = $("#syPath").value.trim() || "data/suppliers.json";
      S.token = $("#syToken").value.trim();
      await saveCfg();
      log("配置已保存到本机");
      FR.toast("已保存");
    };

    $("#syTest").onclick = async () => {
      try {
        log("测试连接…");
        const r = await testConnection();
        log("连接成功：" + r);
        FR.toast("连接成功", 3000);
      } catch (e) { log("连接失败：" + e.message); FR.toast("连接失败：" + e.message, 4000); }
    };

    $("#syPush").onclick = async () => {
      try {
        log("开始上传（元数据 + 原图）…");
        const r = await push(S.scope);
        log(`上传完成：${r.files} 个文件（含 ${r.photos} 张照片），commit ${r.sha}`);
        FR.toast("上传完成", 4000);
        window.renderSync();
      } catch (e) { log("上传失败：" + e.message); FR.toast("上传失败：" + e.message, 5000); }
    };

    $("#syPushMeta").onclick = async () => {
      try {
        log("开始上传（仅元数据）…");
        const r = await push("meta");
        log(`上传完成：${r.files} 个文件，commit ${r.sha}`);
        FR.toast("上传完成", 4000);
        window.renderSync();
      } catch (e) { log("上传失败：" + e.message); FR.toast("上传失败：" + e.message, 5000); }
    };

    $("#syPull").onclick = async () => {
      try {
        if (!confirm("从云端恢复会覆盖本机同名记录的旧版本（较新的本地记录不会被覆盖）。继续？")) return;
        log("开始拉取…");
        const r = await pull();
        log(`拉取完成：新增/更新记录 ${r.suppliers}，计划 ${r.plans}，照片 ${r.photos}（云端共 ${r.remote} 条）`);
        FR.toast("恢复完成", 4000);
        window.renderSync();
      } catch (e) { log("拉取失败：" + e.message); FR.toast("拉取失败：" + e.message, 5000); }
    };

    if (configured()) {
      remoteCount().then((r) => { $("#syRemote").textContent = r; });
    }
  };
})();
