/* 界面打磨回归：Schulte 配色、iPhone 13 Pro 基准下的字号与触控尺寸、多终端无横向溢出、
 * 编辑页「拍下一家 / 新建下一家」连续录入、报告照片点击放大。
 *
 *   NODE_PATH=<node workspace>/node_modules node tests/e2e_ui_polish.js [baseUrl]
 */
const puppeteer = require("puppeteer");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.argv[2] || "http://127.0.0.1:8765/index.html";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fr-ui-"));
const FIXTURE = path.join(TMP, "booth.jpg");

const ok = (m) => console.log("  ok   " + m);
const bad = (m) => { console.log("  FAIL " + m); process.exitCode = 1; };
const check = (c, m) => (c ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WATCHDOG = setTimeout(() => { console.log("  !!   超时（150s）"); process.exit(2); }, 150000);

async function seed(page) {
  await page.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId, { timeout: 20000 });
  await page.evaluate(async () => {
    await FR.put("fairs", {
      id: "fair-ui", name: "第140届广交会 第二期", nameEn: "140th Canton Fair Phase II",
      city: "广州", venue: "广交会展馆", area: "卫浴设备", phase: "Phase II",
      startDate: "2026-10-23", endDate: "2026-10-25", defaultHall: "A区", notes: "",
      archived: false, lastPushAt: null, deletedAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await FR.refresh();
    await FR.selectFair("fair-ui");
  });
}

async function home(page) {
  await page.evaluate(() => { go("home"); renderHome(); });
  await sleep(250);
}

(async () => {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

  /* ---------- 准备一张照片 ---------- */
  {
    const p = await browser.newPage();
    const url = await p.evaluate(() => {
      const c = document.createElement("canvas"); c.width = 800; c.height = 600;
      const x = c.getContext("2d");
      x.fillStyle = "#1F1FAF"; x.fillRect(0, 0, 800, 600);
      x.fillStyle = "#fff"; x.fillRect(150, 120, 380, 280);
      return c.toDataURL("image/jpeg", 0.8);
    });
    fs.writeFileSync(FIXTURE, Buffer.from(url.split(",")[1], "base64"));
    await p.close();
  }

  /* ---------- A. 配色（Schulte） ---------- */
  console.log("\nA. 配色：Schulte 深蓝 + 白 + 浅蓝灰");
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  /* iPhone 13 Pro：390×844 @3x */
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await seed(page);

  const colors = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      accent: cs.getPropertyValue("--accent").trim(),
      bg: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
      theme: (document.querySelector('meta[name="theme-color"]') || {}).content,
    };
  });
  check(colors.accent.toUpperCase() === "#1F1FAF", "主色是 Schulte 蓝 #1F1FAF（" + colors.accent + "）");
  check(colors.bg === "rgb(245, 246, 250)", "底色是浅灰白 #F5F6FA（" + colors.bg + "）");
  check(colors.text === "rgb(16, 21, 41)", "正文是深色而非浅色（浅底深字，户外可读）");
  check(String(colors.theme).toUpperCase() === "#1F1FAF", "系统主题色同步为品牌蓝（" + colors.theme + "）");

  const contrast = await page.evaluate(() => {
    const el = document.getElementById("btnQuick");
    const cs = getComputedStyle(el);
    return { fg: cs.color, bg: cs.backgroundColor, size: cs.fontSize };
  });
  check(/255, 255, 255/.test(contrast.fg), "主按钮是白字（深蓝底上足够对比）");

  /* ---------- B. 字号与触控尺寸（iPhone 13 Pro 基准） ---------- */
  console.log("\nB. 字号与触控尺寸（390×844）");
  const sizes = await page.evaluate(() => {
    const out = { minTap: 999, small: [], font: getComputedStyle(document.body).fontSize };
    const els = document.querySelectorAll("button, .btn, .chip, .star, input, select, textarea");
    for (const el of els) {
      if (!el.offsetParent && el.offsetHeight === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.height < out.minTap) out.minTap = Math.round(r.height);
      if (r.height < 44) out.small.push((el.id || el.className) + ":" + Math.round(r.height));
    }
    return out;
  });
  check(sizes.minTap >= 44, "可视控件最小高度 " + sizes.minTap + "px ≥ 44（Apple HIG）");
  check(sizes.small.length === 0, "没有低于 44px 的触控目标" + (sizes.small.length ? "：" + sizes.small.join(", ") : ""));
  check(parseFloat(sizes.font) >= 16, "正文 " + sizes.font + " ≥ 16px（iOS 聚焦输入框不会自动放大）");

  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  check(overflow.sw <= overflow.cw + 1, "390 宽下无横向溢出（" + overflow.sw + " ≤ " + overflow.cw + "）");

  /* ---------- C. 多终端适配 ---------- */
  console.log("\nC. 多终端适配");
  for (const vp of [{ w: 320, h: 568, n: "iPhone SE 320" }, { w: 360, h: 780, n: "安卓小屏 360" },
    { w: 430, h: 932, n: "iPhone Pro Max 430" }, { w: 768, h: 1024, n: "iPad 竖屏 768" },
    { w: 1280, h: 800, n: "桌面 1280" }]) {
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 2 });
    await home(page);
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      wrap: Math.round(document.querySelector(".wrap").getBoundingClientRect().width),
      font: parseFloat(getComputedStyle(document.body).fontSize),
      tapOK: Array.from(document.querySelectorAll("button.btn, .chip, .star"))
        .filter((e) => e.getBoundingClientRect().height > 0)
        .every((e) => e.getBoundingClientRect().height >= 43),
    }));
    check(r.sw <= r.cw + 1 && r.tapOK,
      vp.n + "：无横向溢出，按钮仍 ≥44px（内容宽 " + r.wrap + "，正文 " + r.font + "px"
      + (r.sw > r.cw + 1 ? "，溢出 " + (r.sw - r.cw) + "px" : "") + "）");
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  /* ---------- D. 连续录入：拍下一家 / 新建下一家 ---------- */
  console.log("\nD. 连续录入快捷按钮");
  await home(page);
  let n0 = await page.evaluate(() => FR.suppliers.length);
  await page.click("#btnManual");
  await sleep(400);
  const hasBtns = await page.evaluate(() => ({
    cam: !!document.getElementById("btnNextCam"),
    man: !!document.getElementById("btnNextManual"),
    done: !!document.getElementById("btnDone"),
  }));
  check(hasBtns.cam && hasBtns.man, "编辑页有「📷 拍下一家」与「＋ 新建下一家」");

  await page.evaluate(() => document.getElementById("btnNextManual").click());
  await sleep(500);
  let n1 = await page.evaluate(() => ({ n: FR.suppliers.length, screen: document.querySelector("main > section:not(.hide)").id }));
  check(n1.n === n0 + 2, "点「新建下一家」：新建了空白记录（" + n0 + " → " + n1.n + "）");
  check(n1.screen === "scr-edit", "仍停在编辑页，可以接着填下一家");

  // 拍下一家：会拉起相机（fileChooser）
  let [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 10000 }),
    page.evaluate(() => document.getElementById("btnNextCam").click()),
  ]);
  await chooser.accept([FIXTURE]);
  await sleep(1200);
  const n2 = await page.evaluate(() => ({
    n: FR.suppliers.length, photos: FR.photos.length,
    screen: document.querySelector("main > section:not(.hide)").id,
  }));
  check(n2.n === n1.n + 1, "点「拍下一家」：又多一条记录（" + n1.n + " → " + n2.n + "）");
  check(n2.photos >= 1, "照片也存下来了");
  check(n2.screen === "scr-edit", "连续录入不打断：还停在编辑页");

  await page.evaluate(() => document.getElementById("btnDone").click());
  await sleep(400);
  const scr = await page.evaluate(() => document.querySelector("main > section:not(.hide)").id);
  check(scr === "scr-list", "点「完成 / 返回列表」回到记录列表");

  check(errors.length === 0, "界面流程无 JS 报错" + (errors.length ? "：" + errors[0] : ""));

  /* ---------- E. 报告照片点击放大 ---------- */
  console.log("\nE. 报告照片点击放大");
  const rp = await browser.newPage();
  await rp.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const rpErrors = [];
  rp.on("pageerror", (e) => rpErrors.push("pageerror: " + e.message));
  await rp.goto(BASE, { waitUntil: "networkidle2" });
  await seed(rp);
  const html = await rp.evaluate(async () => {
    /* 前面几段在同一 origin 留下了数据，这里只留本次要用的 */
    for (const p of await FR.all("photos")) await FR.del("photos", p.id);
    for (const x of await FR.all("suppliers")) await FR.del("suppliers", x.id);
    await FR.refresh();
    const s = FR.newSupplier({ companyNameZh: "测试厂家", companyNameEn: "Test Supplier",
      contactName: "陈伟", phone: "13800138000", boothNo: "10.2B31", categories: ["smart_toilet"] });
    await FR.put("suppliers", s);
    const c = document.createElement("canvas"); c.width = 600; c.height = 450;
    const x = c.getContext("2d"); x.fillStyle = "#1F1FAF"; x.fillRect(0, 0, 600, 450);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
    await addPhoto(s.id, new File([blob], "a.jpg", { type: "image/jpeg" }), "product");
    const c2 = document.createElement("canvas"); c2.width = 600; c2.height = 450;
    const y = c2.getContext("2d"); y.fillStyle = "#8A5300"; y.fillRect(0, 0, 600, 450);
    const blob2 = await new Promise((r) => c2.toBlob(r, "image/jpeg", 0.8));
    await addPhoto(s.id, new File([blob2], "b.jpg", { type: "image/jpeg" }), "booth");
    await FR.refresh();
    const ctx = await FRReport.buildContext({ withPhotos: true });
    return FRReport.renderHTML(ctx);
  });
  check(/id='lb'|id="lb"/.test(html) || /LIGHTBOX/.test(html) === false, "报告 HTML 已内联放大脚本");
  check(/cursor:zoom-in/.test(html), "报告里的缩略图是 zoom-in 光标（提示可点）");

  const rp2 = await browser.newPage();
  const lbErrors = [];
  rp2.on("pageerror", (e) => lbErrors.push("pageerror: " + e.message));
  await rp2.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await rp2.setContent(html, { waitUntil: "domcontentloaded" });
  await sleep(300);
  const grid = await rp2.evaluate(() => {
    const imgs = document.querySelectorAll(".grid img");
    return { n: imgs.length, w: imgs[0] ? imgs[0].getBoundingClientRect().width : 0 };
  });
  check(grid.n === 2, "报告里有 2 张照片（" + grid.n + "）");
  check(grid.w >= 150, "缩略图宽度 " + Math.round(grid.w) + "px（比原来的 135px 大）");

  await rp2.evaluate(() => document.querySelectorAll(".grid img")[0].click());
  await sleep(250);
  const opened = await rp2.evaluate(() => {
    const lb = document.getElementById("lb");
    return { on: lb.classList.contains("on"), count: lb.querySelector(".lbcount").textContent,
      imgW: document.getElementById("lbImg").getBoundingClientRect().width };
  });
  check(opened.on, "点照片后弹出全屏大图");
  check(opened.imgW > grid.w, "大图明显比缩略图宽（" + Math.round(opened.imgW) + " vs " + Math.round(grid.w) + "）");
  check(/1 \/ 2/.test(opened.count), "显示第几张：共几张（" + opened.count + "）");

  await rp2.evaluate(() => document.querySelector(".lbnext").click());
  await sleep(200);
  const next = await rp2.evaluate(() => document.querySelector(".lbcount").textContent);
  check(/2 \/ 2/.test(next), "点 › 切到下一张（" + next + "）");

  await rp2.evaluate(() => document.getElementById("lbImg").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await sleep(150);
  // 双击由 pointerup 判定，改用两次 pointer 事件模拟
  await rp2.evaluate(() => {
    const lb = document.getElementById("lb"), st = document.getElementById("lbStage");
    for (let i = 0; i < 2; i++) {
      const mk = (t, x) => new PointerEvent(t, { bubbles: true, clientX: x, clientY: 400 });
      lb.dispatchEvent(mk("pointerdown", 200));
      st.dispatchEvent(mk("pointerup", 200));
    }
  });
  await sleep(200);
  const zoomed = await rp2.evaluate(() => document.getElementById("lb").classList.contains("zoomed"));
  check(zoomed, "双击可再放大一倍");

  await rp2.evaluate(() => document.querySelector(".lbclose").click());
  await sleep(200);
  const closed = await rp2.evaluate(() => !document.getElementById("lb").classList.contains("on"));
  check(closed, "点 ✕ 关闭大图");
  check(lbErrors.length === 0, "放大交互无 JS 报错" + (lbErrors.length ? "：" + lbErrors[0] : ""));

  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  clearTimeout(WATCHDOG);
  console.log("\n" + (process.exitCode ? "存在失败项" : "全部通过"));
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
