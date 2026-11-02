/* 云端备份的「分批 + 续传 + 调度」回归测试。
 *
 * 背景：2026-11 用户报告备份一直不成功，日志只有一行 "Starting backup"。
 * 根因有三层，这个用例逐个盯住：
 *   1. 照片全量 base64 后一次性提交，100 多张时既吃内存又没有进度；
 *      现在按 12 张一批提交，日志每 5 张刷一次。
 *   2. 传到一半失败，整批白传；现在已提交的批次留在云端，重来时跳过。
 *   3. Scheduler 把"正在跑的那个 promise"返回给后来的调用方，
 *      排队的那次没人 await，异常被吞 —— 日志里看起来像卡死。
 *
 * 不碰真实仓库：fetch 被替换成内存版 GitHub API。
 */
const puppeteer = require("puppeteer");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8765/";
const N_PHOTO = 30;
const BATCH = 12;
const N_MORE = BATCH + 6;      // 断网场景用的新增照片：跨两批，第一批能提交成功

let ok = 0, bad = 0;
const check = (cond, msg) => {
  if (cond) { ok++; console.log("  ok  " + msg); }
  else { bad++; console.log("  FAIL " + msg); }
};

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(BASE, { waitUntil: "networkidle0" });

  /* ---- 内存版 GitHub：记录提交次数、可随时断网 ---- */
  await page.evaluate(() => {
    const store = new Map();
    let seq = 0;
    const sha = () => "s" + (++seq).toString(16).padStart(8, "0");
    const json = (obj, status = 200) => new Promise((r) =>
      setTimeout(() => r(new Response(JSON.stringify(obj), { status,
        headers: { "Content-Type": "application/json" } })), 20));
    window.__mock = { store, blobCalls: 0, commits: 0, failAfter: -1 };
    const realFetch = window.fetch;
    window.fetch = async (url, opt = {}) => {
      const u = new URL(url);
      if (u.host !== "api.github.com") return realFetch(url, opt);
      const p = u.pathname, m = (opt.method || "GET").toUpperCase();
      const mock = window.__mock;
      if (p.endsWith("/git/blobs") && m === "POST") {
        mock.blobCalls++;
        if (mock.failAfter >= 0 && mock.blobCalls > mock.failAfter) {
          throw new TypeError("Failed to fetch");
        }
      }
      if (p === "/user") return json({ login: "tester", id: 1 });
      if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return json({
        full_name: "tester/private-data", private: true, default_branch: "main",
        permissions: { push: true },
      });
      if (p.endsWith("/git/trees/main") && m === "GET") return json({
        tree: [...store.entries()].filter(([k]) => !k.startsWith("__"))
          .map(([path, v]) => ({ path, type: "blob", sha: v.sha, size: 1 })),
      });
      if (p.endsWith("/git/blobs") && m === "POST") {
        const s = sha();
        store.set("__b" + s, { content: JSON.parse(opt.body).content });
        return json({ sha: s });
      }
      if (/\/git\/blobs\/\w+$/.test(p) && m === "GET") {
        const e = store.get("__b" + p.split("/").pop());
        return json({ content: e ? e.content : "", encoding: "base64" });
      }
      if (p.endsWith("/git/ref/heads/main")) return json({ object: { sha: "head0" } });
      if (/\/git\/commits\/\w+$/.test(p) && m === "GET") return json({ tree: { sha: "base" } });
      if (p.endsWith("/git/trees") && m === "POST") {
        for (const t of JSON.parse(opt.body).tree) {
          const e = store.get("__b" + t.sha);
          if (e) store.set(t.path, e);
        }
        return json({ sha: "t" + sha() });
      }
      if (p.endsWith("/git/commits") && m === "POST") {
        mock.commits++;
        return json({ sha: "c" + sha() });
      }
      if (p.includes("/git/refs/heads/") && m === "PATCH") return json({ ok: true });
      return json({ message: "unhandled " + m + " " + p }, 404);
    };
  });

  /* ---- 造一份有 30 张照片的展会 ---- */
  await page.evaluate(async (n) => {
    const f = { id: "f-resume", name: "Resume Fair", nameEn: "Resume Fair", city: "", venue: "",
      area: "", phase: "", startDate: "", endDate: "", defaultHall: "Hall A", notes: "",
      archived: false, lastPushAt: null, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), deletedAt: null };
    await FR.put("fairs", f);
    await FR.selectFair("f-resume");
    const s = FR.newSupplier({ companyNameEn: "Resume Factory", categories: ["shower_enclosure"] });
    await FR.put("suppliers", s);
    const bytes = (kb) => {
      const u = new Uint8Array(kb * 1024);
      for (let i = 0; i < u.length; i += 4096) u[i] = i % 251;
      return u;
    };
    for (let i = 0; i < n; i++) {
      const blob = new Blob([bytes(120)], { type: "image/jpeg" });
      await FR.put("photos", { id: "ph-" + i, fairId: "f-resume", supplierId: s.id, type: "gallery",
        blob, size: blob.size, sha256: "h" + i, createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), deletedAt: null });
    }
    await FR.refresh();
    await FR.setKV("gh", { owner: "tester", repo: "private-data", branch: "main", root: "users",
      token: "github_pat_MOCK", login: "tester", namespace: "tester", scope: "meta",
      encrypt: false, repoPrivate: true, lastSyncAt: null });
    await renderSync();
    go("sync");
  }, N_PHOTO);

  const state = () => page.evaluate(() => ({
    log: document.getElementById("syLog").innerText.split("\n").filter(Boolean),
    assets: [...window.__mock.store.keys()].filter((k) => k.includes("/assets/")).length,
    commits: window.__mock.commits,
    blobCalls: window.__mock.blobCalls,
  }));

  /* ---- 1) 全量备份：分批提交 + 有进度 ---- */
  let r = await page.evaluate(() => window.FRSync.push("full").then(
    (x) => ({ ok: x }), (e) => ({ err: e.message })));
  check(!r.err, "全量备份成功" + (r.err ? "：" + r.err : ""));
  let st = await state();
  check(st.assets === N_PHOTO, `30 张照片全部落地（实际 ${st.assets}）`);
  check(st.commits === Math.ceil(N_PHOTO / BATCH) + 1,
    `按 ${BATCH} 张一批提交，共 ${Math.ceil(N_PHOTO / BATCH)} 批 + 1 次收尾（实际 ${st.commits}）`);
  check(st.log.some((l) => /new photo\(s\) to upload/.test(l)), "开始前先报要传多少张、多大");
  check(st.log.some((l) => /Photos \d+\/\d+ uploaded/.test(l)), "上传过程有进度输出");

  /* ---- 2) 再跑一次：已上传的必须全部跳过 ---- */
  r = await page.evaluate(() => window.FRSync.push("full").then(
    (x) => ({ ok: x }), (e) => ({ err: e.message })));
  check(!r.err && r.ok && r.ok.skipped === N_PHOTO && r.ok.photos === 0,
    `第二次备份跳过全部照片（skipped=${r.ok && r.ok.skipped}）`);

  /* ---- 3) 传到一半断网：必须报错，且已提交的批次要留住 ---- */
  await page.evaluate(async ({ n, breakAt }) => {
    document.getElementById("syLog").innerHTML = "";
    /* 第一批（12 张）传完并提交，第二批传到第 3 张时断网 */
    window.__mock.failAfter = window.__mock.blobCalls + breakAt;
    const blob = new Blob([""], { type: "image/jpeg" });
    const s = FR.suppliers[0];
    for (let i = 0; i < n; i++) {
      await FR.put("photos", { id: "bad-" + i, fairId: "f-resume", supplierId: s.id, type: "gallery",
        blob, size: 1, sha256: "b" + i, createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), deletedAt: null });
    }
    await FR.refresh();
  }, { n: N_MORE, breakAt: BATCH + 3 });
  const before = (await state()).assets;
  r = await page.evaluate(() => window.FRSync.push("full").then(
    (x) => ({ ok: x }), (e) => ({ err: e.message })));
  check(!!r.err, "断网时报错而不是静默卡住（" + String(r.err || "").slice(0, 40) + "）");
  check(/api\.github\.com|Failed to fetch|reach/i.test(String(r.err || "")),
    "错误里说清是连不上 GitHub");
  st = await state();
  check(st.assets > before, `断网前已提交的那一批留在云端（${before} → ${st.assets}）`);

  /* ---- 4) 网络恢复：从断点继续，不重传 ---- */
  await page.evaluate(() => { window.__mock.failAfter = -1; });
  r = await page.evaluate(() => window.FRSync.push("full").then(
    (x) => ({ ok: x }), (e) => ({ err: e.message })));
  check(!r.err, "恢复后重试成功" + (r.err ? "：" + r.err : ""));
  check(r.ok && r.ok.skipped >= N_PHOTO, `已上传的不重传（skipped=${r.ok && r.ok.skipped}）`);
  const finalAssets = (await state()).assets;
  check(finalAssets === N_PHOTO + N_MORE, `最终照片齐全（实际 ${finalAssets}）`);

  check(errors.length === 0, "无 JS 报错" + (errors.length ? "：" + errors[0] : ""));

  await browser.close();
  console.log(`\n${bad ? "有失败项" : "全部通过"}：ok=${ok} fail=${bad}`);
  process.exit(bad ? 1 : 0);
})();
