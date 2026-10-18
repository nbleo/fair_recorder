/* 端到端云同步联调：PWA → 私有仓 → pull_cloud.py → build_report.py
 *
 *   GH_TOKEN=<pat> NODE_PATH=<node workspace>/node_modules node tests/e2e_cloud.js
 *
 * 走真实 GitHub API（写入私有仓 fairrecorder-data），验证：
 *   1. 手机端能连通私有仓并识别出身份 / 命名空间 / 仓库可见性
 *   2. 记录与照片能按 users/<login>/fairs/<fairId>/ 分块上传
 *   3. Python 侧能把同一份数据拉回来并生成报告
 *
 * 只做正确性检查，不做视觉校验。测试用的展会名带 E2E 前缀，便于事后清理。
 */
const puppeteer = require("puppeteer");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "app");
/* 端口随机：换端口等于换 origin，Service Worker 不会拿旧缓存的 sync.js 来跑 */
const PORT = 8700 + Math.floor(Math.random() * 200);
const TOKEN = process.env.GH_TOKEN || "";
const OWNER = process.env.FR_OWNER || "nbleo";
const REPO = process.env.FR_REPO || "fairrecorder-data";

const ok = (m) => console.log("  ok   " + m);
const bad = (m) => { console.log("  FAIL " + m); process.exitCode = 1; };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json" };

function serve() {
  return new Promise((res) => {
    const s = http.createServer((req, r) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
      const f = path.join(APP, rel);
      if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        r.writeHead(404); r.end("nope"); return;
      }
      r.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
      fs.createReadStream(f).pipe(r);
    });
    s.listen(PORT, "127.0.0.1", () => res(s));
  });
}

(async () => {
  if (!TOKEN) { console.error("set GH_TOKEN first"); process.exit(2); }

  const server = await serve();
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });
  const tap = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error("no element " + s);
    el.click();
  }, sel);
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle2" });
    await page.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId,
      { timeout: 20000 });

    /* --- 1) 建一个专用展会（走 UI，和真机操作一致） --- */
    await tap("#btnFairNew");
    await page.waitForSelector("#fName", { visible: true });
    await page.evaluate(() => { document.querySelector("#fName").value = ""; });
    await page.type("#fName", "E2E 云端联调测试");
    await page.type("#fNameEn", "E2E Cloud Sync Check");
    await page.evaluate(() => {
      document.querySelector("#fStart").value = "2026-10-23";
      document.querySelector("#fEnd").value = "2026-10-25";
    });
    await tap("#fSave");
    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate(async () => {
      const all = await FR.all("fairs");
      const f = all.find((x) => /E2E/.test(x.name || "")) || all[0];
      await FR.selectFair(f.id);
      go("home");
    });
    const fairId = await page.evaluate(() => FR.fair && FR.fair.id);
    check(!!fairId, `当前展会已就绪（id=${String(fairId).slice(0, 8)}）`);

    /* --- 2) 录两家供应商 + 一张照片 --- */
    async function addSupplier(zh, contact, phone, booth) {
      await tap("#btnManual");
      await page.waitForSelector('#editForm input[data-k="companyNameZh"]', { timeout: 8000 });
      await page.type('#editForm input[data-k="companyNameZh"]', zh);
      await page.type('#editForm input[data-k="contactName"]', contact);
      await page.type('#editForm input[data-k="phone"]', phone);
      await page.type('#editForm input[data-k="boothNo"]', booth);
      await new Promise((r) => setTimeout(r, 250));
      await page.evaluate(() => go("home"));   // 草稿即时入库，返回首页即可
      await new Promise((r) => setTimeout(r, 250));
    }
    await addSupplier("E2E 测试卫浴一厂", "张一", "+86 138 0000 0001", "E2E-01");
    await addSupplier("E2E 测试卫浴二厂", "李二", "+86 138 0000 0002", "E2E-02");
    const n = await page.evaluate(() => FR.suppliers.length);
    check(n === 2, `已录入 2 家供应商（实际 ${n}）`);

    const photo = await page.evaluate(async () => {
      const sid = FR.suppliers[0].id;
      const c = document.createElement("canvas"); c.width = 640; c.height = 480;
      const g = c.getContext("2d");
      g.fillStyle = "#123456"; g.fillRect(0, 0, 640, 480);
      g.fillStyle = "#ffffff"; g.font = "48px sans-serif"; g.fillText("E2E", 260, 250);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
      const file = new File([blob], "e2e.jpg", { type: "image/jpeg" });
      const p = await addPhoto(sid, file, "product");
      await FR.refresh();
      return { id: p.id, size: p.size };
    });
    check(photo.size > 0, `已生成测试照片（${photo.size} 字节）`);

    /* --- 3) 配置云同步（走 UI，验证保存按钮真的能用） --- */
    await page.evaluate(() => go("sync"));
    await page.waitForSelector("#syToken", { timeout: 8000 });
    await page.evaluate((o, r, t) => {
      document.getElementById("syOwner").value = o;
      document.getElementById("syRepo").value = r;
      document.getElementById("syBranch").value = "main";
      document.getElementById("syRoot").value = "users";
      document.getElementById("syNamespace").value = "";
      document.getElementById("syToken").value = t;
    }, OWNER, REPO, TOKEN);
    const before = await page.evaluate(() => ({
      owner: document.getElementById("syOwner").value,
      repo: document.getElementById("syRepo").value,
      tokenLen: (document.getElementById("syToken").value || "").length,
    }));
    console.log("  [debug] 点击前输入框：owner=" + before.owner
      + " repo=" + before.repo + " token长度=" + before.tokenLen);
    await tap("#sySave");
    /* 保存后会异步校验一次仓库，要发 2 个真实请求，给足时间（实测约 3 秒） */
    await page.waitForFunction(async () => {
      const kv = await FR.getKV("gh", null);
      return !!(kv && kv.login);
    }, { timeout: 20000, polling: 400 }).catch(() => { /* 断言在下面给出 */ });

    const cfg = await page.evaluate(async () => {
      const kv = await FR.getKV("gh", null);
      return { owner: kv.owner, repo: kv.repo, login: kv.login, repoPrivate: kv.repoPrivate };
    });
    check(cfg.owner === OWNER && cfg.repo === REPO, `配置已保存（${cfg.owner}/${cfg.repo}）`);
    check(cfg.login === "nbleo", `识别出 GitHub 身份（${cfg.login}）`);
    check(cfg.repoPrivate === true, `仓库可见性校验为私有（${cfg.repoPrivate}）`);

    const vis = await page.$eval("#syVis", (el) => el.textContent.trim());
    check(/私有|private/i.test(vis), `同步页显示仓库可见性：${vis}`);
    if (!/私有|private/i.test(vis)) {
      const logs = await page.$eval("#syLog", (el) => el.textContent.trim().slice(0, 300));
      console.log("  ---- 同步页日志 ----\n  " + logs.replace(/\s*\n\s*/g, "\n  "));
    }

    /* --- 4) 测试连接 --- */
    const conn = await page.evaluate(async () => {
      try { return { ok: true, msg: await window.FRSync.testConnection() }; }
      catch (e) { return { ok: false, msg: e.message }; }
    });
    check(conn.ok, `测试连接通过（${String(conn.msg).slice(0, 60)}）`);

    /* --- 5) 全量备份（含照片） --- */
    const push = await page.evaluate(async () => {
      try { return { ok: true, r: await window.FRSync.push("full") }; }
      catch (e) { return { ok: false, msg: e.message }; }
    });
    if (!push.ok) { bad("push 失败：" + push.msg); }
    else {
      const r = push.r;
      check(r.files >= 2, `已上传 ${r.files} 个文件（脏块 ${r.chunks} / 新照片 ${r.photos}）`);
      check(r.photos >= 1, `照片已上传到云端（${r.photos} 张）`);
      check(!!r.sha, `提交 sha = ${r.sha}`);
    }

    /* --- 6) 第二次 push 应命中增量（照片跳过） --- */
    const push2 = await page.evaluate(async () => {
      try { return { ok: true, r: await window.FRSync.push("full") }; }
      catch (e) { return { ok: false, msg: e.message }; }
    });
    if (push2.ok) {
      check(push2.r.skipped >= 1, `二次备份跳过已上传照片（skipped=${push2.r.skipped}）`);
    } else {
      bad("二次 push 失败：" + push2.msg);
    }

    console.log("");
    console.log("CLOUD_PATH=users/nbleo/fairs/" + fairId);
    console.log("FAIR_ID=" + fairId);
  } finally {
    await browser.close();
    server.close();
  }

  console.log("");
  if (errors.length) {
    console.log("页面错误：");
    errors.slice(0, 10).forEach((e) => console.log("   " + e));
    process.exitCode = 1;
  } else {
    console.log("无 JS 运行时错误");
  }
})().catch((e) => { console.error("e2e failed:", e); process.exit(1); });
