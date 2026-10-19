/* 多端删除联调：A 设备删展会 → 云端墓碑 → B 设备同步后跟着删
 *
 *   GH_TOKEN=<pat> NODE_PATH=<node workspace>/node_modules node tests/e2e_fair_delete_cloud.js
 *
 * 走真实 GitHub API（写私有仓 fairrecorder-data）。展会名带 E2E-DEL 前缀，
 * 跑完用 scripts/purge_cloud.py --starts-with "E2E-DEL" --yes 清掉。
 */
const puppeteer = require("puppeteer");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "app");
const PORT = 8900 + Math.floor(Math.random() * 90);
const TOKEN = process.env.GH_TOKEN || "";
const OWNER = process.env.FR_OWNER || "nbleo";
const REPO = process.env.FR_REPO || "fairrecorder-data";
const FAIR_NAME = "E2E-DEL " + new Date().toISOString().slice(11, 19).replace(/:/g, "");

const ok = (m) => console.log("  ok   " + m);
const bad = (m) => { console.log("  FAIL " + m); process.exitCode = 1; };
const check = (c, m) => (c ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* 每台"设备"：独立的浏览器上下文 = 独立的 IndexedDB */
async function device(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId, { timeout: 20000 });
  /* 必须先切到同步页：#sySave 的 onclick 是 renderSync() 里才绑上的 */
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
  await page.evaluate(() => document.getElementById("sySave").click());
  await page.waitForFunction(async () => {
    const kv = await FR.getKV("gh", null);
    return !!(kv && kv.login);
  }, { timeout: 30000, polling: 500 });
  return { ctx, page };
}

(async () => {
  if (!TOKEN) { console.error("set GH_TOKEN first"); process.exit(2); }
  const server = await serve();
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  let fairId = null;

  try {
    /* ---------- 设备 A：建展会 + 录一条 + 上传 ---------- */
    const A = await device(browser);
    const setup = await A.page.evaluate(async (name) => {
      await FR.put("fairs", { id: "e2e-del-" + Date.now().toString(36), name,
        nameEn: "E2E Delete Check", city: "", venue: "", area: "", phase: "",
        startDate: "2026-10-23", endDate: "2026-10-25", defaultHall: "A区", notes: "",
        archived: false, lastPushAt: null, createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), deletedAt: null });
      await FR.refresh();
      const f = FR.fairs.find((x) => x.name === name);
      await FR.selectFair(f.id);
      const s = FR.newSupplier({ companyNameZh: "E2E 待删除厂家", contactName: "王五",
        phone: "+86 138 0000 0009", categories: ["smart_toilet"] });
      await FR.put("suppliers", s);
      await FR.refresh();
      const r = await window.FRSync.push("meta");
      return { id: f.id, suppliers: FR.suppliers.length, files: r.files, sha: r.sha };
    }, FAIR_NAME);
    fairId = setup.id;
    check(setup.suppliers === 1 && setup.files >= 1,
      `A 设备已上传${setup.files}个文件（commit ${setup.sha}）`);

    /* ---------- 设备 B：拉一次，先拿到这个展会 ---------- */
    const B = await device(browser);
    const pulled1 = await B.page.evaluate(async (id) => {
      const res = await window.FRSync.pullFair(id, { photos: false });
      await FR.refresh();
      await FR.selectFair(id);
      return { res, has: FR.fairs.some((f) => f.id === id), n: FR.suppliers.length };
    }, fairId);
    check(pulled1.has, "B 设备拉取后已拿到该展会");
    check(pulled1.n === 1, `B 设备拿到 1 条记录（实际 ${pulled1.n}）`);

    /* ---------- A 设备删除（三重确认全过） ---------- */
    const del = await A.page.evaluate(async (id) => {
      const realC = window.confirm, realP = window.prompt;
      window.confirm = () => true;
      window.prompt = () => (FR.fairs.find((f) => f.id === id) || { name: "" }).name || "";
      let pushed = null, err = null;
      try {
        await FR.deleteFairFlow(id);
        pushed = "ok";
      } catch (e) { err = e.message; }
      window.confirm = realC; window.prompt = realP;
      const raw = await FR.all("fairs");
      return { pushed, err, tombstone: !!(raw.find((f) => f.id === id) || {}).deletedAt,
               gone: !FR.fairs.some((f) => f.id === id) };
    }, fairId);
    check(!del.err && del.pushed === "ok", "A 设备删除流程走通" + (del.err ? "（" + del.err + "）" : ""));
    check(del.tombstone, "本机保留墓碑（deletedAt）");
    check(del.gone, "A 设备展会列表里已消失");

    /* 云端 meta 上必须有 deletedAt——这是别的设备能跟着删的唯一依据 */
    const cloud = await A.page.evaluate(async (id) => {
      const list = await window.FRSync.listRemoteFairs();
      const f = list.find((x) => x.id === id);
      return f ? { found: true, deleted: !!f.deleted, name: f.name } : { found: false };
    }, fairId);
    check(cloud.found && cloud.deleted, `云端 meta 已标记删除（${cloud.name}）`);

    /* ---------- B 设备再同步一次：应当跟着删掉 ---------- */
    const pulled2 = await B.page.evaluate(async (id) => {
      const res = await window.FRSync.pullFair(id, { photos: false });
      await FR.refresh();
      const raw = await FR.all("suppliers");
      return {
        deleted: !!(res && res.deleted),
        stillThere: FR.fairs.some((f) => f.id === id),
        tombstoned: raw.filter((s) => s.fairId === id).every((s) => !!s.deletedAt),
      };
    }, fairId);
    check(pulled2.deleted, "B 设备拉取时识别到墓碑");
    check(!pulled2.stillThere, "B 设备上的同一展会已被删除（多端删除生效）");
    check(pulled2.tombstoned, "B 设备上该展会的记录已打墓碑（不会再出现在列表）");

    /* ---------- 全量拉取也要能处理墓碑 ---------- */
    const all = await B.page.evaluate(async () => {
      const res = await window.FRSync.pullAll({ photos: false });
      return { n: res.length, deleted: res.filter((r) => r.deleted).length,
               err: res.filter((r) => r.error).length };
    });
    check(all.err === 0, `全量拉取无失败展会（共 ${all.n} 个，其中墓碑 ${all.deleted} 个）`);
  } finally {
    await browser.close();
    server.close();
  }

  console.log("");
  console.log("清理命令：GITHUB_TOKEN=… python scripts/purge_cloud.py --starts-with \"E2E-DEL\" --yes");
  console.log("FAIR_ID=" + fairId);
})().catch((e) => { console.error("multi-device delete test failed:", e); process.exit(1); });
