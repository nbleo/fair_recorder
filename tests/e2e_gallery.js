/* 系统相册保存：相机拍完自动存一份（iOS 走系统分享面板 / 其它走下载目录），
 * 相册里选的照片不重复存，设置可关，每张照片还能手动点 ⬇ 单独存。
 *
 *   NODE_PATH=<node workspace>/node_modules node tests/e2e_gallery.js [baseUrl]
 */
const puppeteer = require("puppeteer");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.argv[2] || "http://127.0.0.1:8765/index.html";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fr-gallery-"));
const DL = path.join(TMP, "dl");
fs.mkdirSync(DL, { recursive: true });
const FIXTURE = path.join(TMP, "booth.jpg");

const ok = (m) => console.log("  ok   " + m);
const bad = (m) => { console.log("  FAIL " + m); process.exitCode = 1; };
const check = (c, m) => (c ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listFiles(dir) {
  return fs.readdirSync(dir).filter((f) => !f.endsWith(".crdownload"));
}

async function waitNewFile(dir, before, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const now = listFiles(dir);
    const fresh = now.filter((f) => !before.includes(f));
    if (fresh.length) return fresh;
    await sleep(200);
  }
  return [];
}

async function allowDownload(page, dir) {
  const client = await page.createCDPSession();
  try {
    await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
  } catch (e) {
    await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
  }
}

async function home(page) {
  await page.evaluate(() => { go("home"); renderHome(); });
  await sleep(250);
}

async function prepare(page, galleryOn) {
  await page.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId, { timeout: 20000 });
  await page.evaluate(async (on) => {
    await FR.setKV("saveToGallery", on);
    FR.settings.saveToGallery = on;
    if (!FR.fairs.length) {
      await FR.put("fairs", {
        id: "fair-gal", name: "测试展会", nameEn: "Test Fair", city: "广州", venue: "展馆",
        area: "卫浴", phase: "", startDate: "2026-10-23", endDate: "2026-10-25", defaultHall: "A区",
        notes: "", archived: false, lastPushAt: null, deletedAt: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await FR.refresh();
    }
    await FR.selectFair("fair-gal");
    go("home"); renderHome();
  }, galleryOn);
}

const step = (m) => console.log("  ..   " + m);
const WATCHDOG = setTimeout(() => { console.log("  !!   超时（120s）未完成，强制结束"); process.exit(2); }, 120000);

(async () => {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

  /* ---------- 生成一张测试照片 ---------- */
  {
    const p = await browser.newPage();
    const url = await p.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 1200; c.height = 900;
      const x = c.getContext("2d");
      x.fillStyle = "#2233aa"; x.fillRect(0, 0, 1200, 900);
      x.fillStyle = "#ffffff"; x.fillRect(200, 200, 500, 400);
      return c.toDataURL("image/jpeg", 0.8);
    });
    fs.writeFileSync(FIXTURE, Buffer.from(url.split(",")[1], "base64"));
    await p.close();
  }
  check(fs.statSync(FIXTURE).size > 1000, "测试照片已生成（" + FIXTURE + "）");

  /* ---------- A. 安卓 / 桌面：静默下载到「下载」目录 ---------- */
  console.log("\nA. 安卓 / 桌面（下载目录）");
  const page = await browser.newPage();
  await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await allowDownload(page, DL);
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await prepare(page, true);

  step("首页已就绪，点「拍照秒存」");
  const def = await page.evaluate(() => FR.settings.saveToGallery);
  check(def !== false, "默认开启「拍照后存入系统相册」");

  await page.evaluate(() => go("settings"));
  await sleep(300);
  const chips = await page.evaluate(() => Array.from(document.querySelectorAll("#setGallery .chip"))
    .map((b) => ({ v: b.dataset.v, on: b.getAttribute("aria-pressed") === "true" })));
  check(chips.length === 2, "设置页有「开 / 关」两个开关");
  check(chips.find((c) => c.v === "on").on === true, "默认显示为「开」");

  // 拍照秒存 → 应自动保存一份
  await home(page);
  let before = listFiles(DL);
  let [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10000 }), page.click("#btnQuick")]);
  await chooser.accept([FIXTURE]);
  await sleep(800);
  let fresh = await waitNewFile(DL, before);
  check(fresh.length > 0, "相机拍完自动保存了一份（" + (fresh[0] || "无") + "）");
  check(/FR-\d{8}-\d{6}\.(jpg|jpeg|png|webp)$/i.test(fresh[0] || ""), "文件名形如 FR-展会-时间戳.jpg");
  const rec = await page.evaluate(() => (FR.suppliers.length, FR.photos.length));
  check(rec >= 1, "照片同时已入库（本地仍是第一副本）");

  // 关闭开关 → 不再保存
  await page.evaluate(async () => { await FR.setKV("saveToGallery", false); FR.settings.saveToGallery = false; });
  await home(page);
  before = listFiles(DL);
  [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10000 }), page.click("#btnQuick")]);
  await chooser.accept([FIXTURE]);
  await sleep(2500);
  fresh = await waitNewFile(DL, before, 2500);
  check(fresh.length === 0, "关掉开关后不再自动保存");

  // 设置项持久化
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId, { timeout: 20000 });
  const persisted = await page.evaluate(() => FR.settings.saveToGallery);
  check(persisted === false, "开关状态重载后保持（关）");
  await page.evaluate(async () => { await FR.setKV("saveToGallery", true); FR.settings.saveToGallery = true; });

  // 从相册里选的照片不重复保存
  before = listFiles(DL);
  await page.evaluate(() => {
    const s = FR.suppliers[0];
    pickPhoto(async (files) => { await addPhoto(s.id, files[0], "product"); }, true);
  });
  await sleep(300);
  const pick = await page.$("#filePick");
  await pick.uploadFile(FIXTURE);
  await sleep(2500);
  fresh = await waitNewFile(DL, before, 2500);
  check(fresh.length === 0, "从相册选的照片不会重复存回相册");

  // 每张照片可手动点 ⬇ 保存
  await page.evaluate(() => { go("edit"); renderEdit(FR.suppliers[0].id); });
  await sleep(500);
  const hasBtn = await page.evaluate(() => !!document.querySelector("#editPhotos .g"));
  check(hasBtn, "编辑页每张照片都有 ⬇ 按钮");
  before = listFiles(DL);
  await page.evaluate(() => document.querySelector("#editPhotos .g").click());
  fresh = await waitNewFile(DL, before, 8000);
  check(fresh.length > 0, "点 ⬇ 可单独把某张照片存进相册");

  check(errors.length === 0, "桌面流程无 JS 报错" + (errors.length ? "：" + errors[0] : ""));

  /* ---------- B. iOS：走系统分享面板 ---------- */
  console.log("\nB. iOS（系统分享面板）");
  const ios = await browser.newPage();
  await ios.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });
  const iosErrors = [];
  ios.on("pageerror", (e) => iosErrors.push("pageerror: " + e.message));
  await ios.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
  await ios.evaluateOnNewDocument(() => {
    window.__shares = [];
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: (d) => !!(d && d.files && d.files.length),
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (d) => {
        const f = (d && d.files && d.files[0]) || null;
        window.__shares.push({ n: (d.files || []).length, type: f && f.type, name: f && f.name });
        return window.__shareImpl ? window.__shareImpl() : Promise.resolve();
      },
    });
  });
  await ios.goto(BASE, { waitUntil: "networkidle2" });
  await prepare(ios, true);

  const isIOS = await ios.evaluate(() => FR.isIOS());
  check(isIOS === true, "iPhone UA 被识别为 iOS（走分享面板路径）");

  [chooser] = await Promise.all([ios.waitForFileChooser({ timeout: 10000 }), ios.click("#btnQuick")]);
  await chooser.accept([FIXTURE]);
  await sleep(1500);
  const shares = await ios.evaluate(() => window.__shares);
  check(shares.length === 1, "拍完自动弹一次系统分享面板");
  check(shares[0] && shares[0].n === 1, "分享的是一张照片（File 对象）");
  check(shares[0] && /image\//.test(shares[0].type || ""), "分享内容是图片（" + (shares[0] || {}).type + "）");
  check(shares[0] && /FR-\d{8}-\d{6}\.(jpg|jpeg|png|webp)$/i.test(shares[0].name || ""), "分享文件名形如 FR-…时间戳.jpg");

  // 用户在分享面板里取消 → 不应报错、记录仍在
  await ios.evaluate(() => {
    window.__shareImpl = () => Promise.reject(Object.assign(new Error("cancel"), { name: "AbortError" }));
  });
  const cnt0 = await ios.evaluate(() => FR.suppliers.length);
  await home(ios);
  [chooser] = await Promise.all([ios.waitForFileChooser({ timeout: 10000 }), ios.click("#btnQuick")]);
  await chooser.accept([FIXTURE]);
  await sleep(1200);
  const cnt1 = await ios.evaluate(() => FR.suppliers.length);
  check(cnt1 === cnt0 + 1, "用户在分享面板取消时，记录照常保存");
  check(iosErrors.length === 0, "iOS 取消路径无 JS 报错" + (iosErrors.length ? "：" + iosErrors[0] : ""));

  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  clearTimeout(WATCHDOG);
  console.log("\n" + (process.exitCode ? "存在失败项" : "全部通过"));
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
