/* 真机冒烟：用 Chromium 打开 PWA，走一遍「新建展会 → 手动录入 → 切换展会 → 隔离校验」。
 *
 *   NODE_PATH=<node workspace>/node_modules node tests/smoke_app.js [baseUrl]
 *
 * 只做正确性检查，不做视觉校验。
 */
const puppeteer = require("puppeteer");
const path = require("path");

const BASE = process.argv[2] || "http://127.0.0.1:8765/index.html";
const ROOT = path.resolve(__dirname, "..");

const ok = (m) => console.log("  ok   " + m);
const bad = (m) => { console.log("  FAIL " + m); process.exitCode = 1; };
const check = (cond, m) => (cond ? ok(m) : bad(m));

(async () => {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });
  // 用 DOM click 而非鼠标点击：headless 下更稳，不受滚动位置影响
  const tap = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error("no element " + s);
    el.click();
  }, sel);
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(BASE, { waitUntil: "networkidle2" });
  await page.waitForSelector("#scr-fairs, #scr-home", { timeout: 10000 });

  // 1) 首次启动应落在展会页（还没有任何展会）
  let onFairs = await page.$eval("#scr-fairs", (el) => !el.classList.contains("hide"));
  check(onFairs, "首次启动进入展会页");

  // 2) 新建两个展会
  async function newFair(name, nameEn, start, end) {
    await tap("#btnFairNew");
    await page.waitForSelector("#fName", { visible: true });
    await page.evaluate(() => { document.querySelector("#fName").value = ""; });
    await page.type("#fName", name);
    await page.type("#fNameEn", nameEn);
    await page.evaluate((s, e) => {
      document.querySelector("#fStart").value = s;
      document.querySelector("#fEnd").value = e;
    }, start, end);
    await tap("#fSave");
    await new Promise((r) => setTimeout(r, 400));
  }
  await newFair("第140届广交会 第二期", "140th Canton Fair Phase II", "2026-10-23", "2026-10-25");
  await newFair("2026 上海 KBC", "Kitchen & Bath China 2026", "2026-05-26", "2026-05-29");

  const fairCount = await page.evaluate(async () => {
    const all = await FR.all("fairs");
    return all.length;
  });
  check(fairCount === 2, `已创建 2 个展会（实际 ${fairCount}）`);

  // 3) 明确切到广交会（新建后当前展会是最后建的那个）
  await page.evaluate(async () => {
    const all = await FR.all("fairs");
    await FR.selectFair(all.find((f) => f.name.includes("广交会")).id);
    go("home");
  });
  await new Promise((r) => setTimeout(r, 300));
  const home = await page.$eval("#scr-home", (el) => !el.classList.contains("hide"));
  check(home, "新建后回到首页");
  await page.waitForSelector("#homeFair .card", { timeout: 5000 });
  const cardText = await page.$eval("#homeFair", (el) => el.textContent);
  check(/广交会/.test(cardText), "首页卡片显示当前展会名");

  // 4) 手动录入一家供应商
  await tap("#btnManual");
  await page.waitForSelector('#editForm input[data-k="companyNameZh"]', { timeout: 8000 });
  await page.type('#editForm input[data-k="companyNameZh"]', "佛山市南海区金莎卫浴有限公司");
  await page.type('#editForm input[data-k="contactName"]', "陈伟");
  await page.type('#editForm input[data-k="phone"]', "+86 138 0013 8000");
  await page.type('#editForm input[data-k="boothNo"]', "10.2B31");
  await new Promise((r) => setTimeout(r, 300));

  let n1 = await page.evaluate(() => FR.suppliers.length);
  check(n1 === 1, `录入后有 1 条记录（实际 ${n1}）`);
  const fairId1 = await page.evaluate(() => FR.suppliers[0].fairId);
  const curFair1 = await page.evaluate(() => FR.fair.id);
  check(fairId1 === curFair1, "新记录挂在当前展会下");

  // 5) 切到第二个展会，记录数应归零（隔离）
  await page.evaluate(async () => {
    const all = await FR.all("fairs");
    const other = all.find((f) => f.name.includes("KBC"));
    await FR.selectFair(other.id);
  });
  await new Promise((r) => setTimeout(r, 300));
  const n2 = await page.evaluate(() => FR.suppliers.length);
  check(n2 === 0, `切换到 KBC 后记录数为 0（实际 ${n2}）`);
  check(await page.evaluate(() => FR.fair.name.includes("KBC")), "当前展会已切换为 KBC");

  // 6) 导出包体应带 fair 块
  const bundle = await page.evaluate(async () => {
    const { bundle } = await FR.buildBundle("full");
    return { fair: bundle.fair, event: bundle.export && bundle.event, schema: bundle.schemaVersion };
  });
  check(bundle.schema === 2, "schemaVersion = 2");
  check(!!(bundle.fair && bundle.fair.id), "bundle 含 fair.id");
  check(!!(bundle.event && bundle.event.name), "bundle 含 event 抬头");

  // 7) 切回第一个展会，记录仍在
  await page.evaluate(async () => {
    const all = await FR.all("fairs");
    await FR.selectFair(all.find((f) => f.name.includes("广交会")).id);
  });
  await new Promise((r) => setTimeout(r, 300));
  const n3 = await page.evaluate(() => FR.suppliers.length);
  check(n3 === 1, `切回广交会后仍有 1 条记录（实际 ${n3}）`);

  // 8) 未同步计数
  const pend = await page.evaluate(() => FR.pendingChanges());
  check(pend >= 1, `未上传改动计数 = ${pend}`);

  await browser.close();

  console.log("");
  if (errors.length) {
    console.log("页面错误：");
    errors.slice(0, 10).forEach((e) => console.log("   " + e));
    process.exitCode = 1;
  } else {
    console.log("无 JS 运行时错误");
  }
})().catch((e) => { console.error("smoke failed:", e); process.exit(1); });
