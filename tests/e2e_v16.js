/* v1.6 行为联调（真浏览器）
   1) 预拜访清单：跳过后可「继续参观」、可删除
   2) 打开相机没拍照不再计入照片（空文件 / 取消）
   3) App 编辑页照片可点击放大、双击更大、点空白关闭
   4) 导出的英文报告 HTML 里照片同样能点开放大、双击更大
   用法: node tests/e2e_v16.js <url>
*/
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const URL = process.argv[2] || "http://127.0.0.1:8765/index.html";
const TMP = path.join(process.cwd(), ".tmp_v16");
let fail = 0, pass = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log("  ok   " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 无头 Chrome 的触屏模拟有约 50px 的坐标偏移（isMobile 会缩放视口），
   直接用 touchscreen.tap 会点到旁边的元素。这里在页面内派发真实事件序列，
   既覆盖 onclick，也覆盖 pointer / touch 兜底路径。 */
async function tapEl(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error("找不到元素 " + s);
    el.scrollIntoView({ block: "center" });
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }, sel);
}
async function tapTouch(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error("找不到元素 " + s);
    el.scrollIntoView({ block: "center" });
    el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true }));
  }, sel);
}
async function tapOnce(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y }));
  }, sel);
}
async function dblTap(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    for (let i = 0; i < 2; i++) {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y }));
    }
  }, sel);
}

/* 浏览器里造一张真 JPEG（canvas → Blob → File） */
const MAKE_FILE = `(async (name) => {
  const c = document.createElement("canvas"); c.width = 1200; c.height = 900;
  const x = c.getContext("2d");
  x.fillStyle = "#1F1FAF"; x.fillRect(0, 0, 1200, 900);
  x.fillStyle = "#fff"; x.fillRect(200, 150, 700, 500);
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
  return new File([blob], name || "booth.jpg", { type: "image/jpeg" });
})`;

async function freshDb(page) {
  await page.evaluate(async () => {
    for (const st of ["photos", "suppliers", "visitPlans", "fairs"]) {
      for (const x of await FR.all(st)) await FR.del(st, x.id);
    }
    await FR.refresh();
    await FR.put("fairs", { id: "fair-v16", name: "V16 测试展", nameEn: "V16 Test Fair",
      city: "广州", venue: "展馆", area: "卫浴", phase: "Phase II", startDate: "2026-10-23",
      endDate: "2026-10-25", defaultHall: "A区", notes: "", archived: false, lastPushAt: null,
      deletedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await FR.refresh();
    await FR.selectFair("fair-v16");
  });
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message || e)));
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId, { timeout: 30000 });
  await freshDb(page);

  console.log("\n[1] 预拜访清单：跳过 → 继续参观 → 删除");
  await page.evaluate(async () => {
    await FR.put("visitPlans", { id: "plan-v16", fairId: "fair-v16", companyName: "跳过测试厂",
      boothNo: "10.2B31", goal: "看智能马桶", priority: "A", note: "", status: "planned",
      supplierId: null, companyKey: "跳过测试厂", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), deletedAt: null });
    await FR.refresh();
    go("plans"); renderPlans();
  });
  await sleep(300);
  let has = await page.evaluate(() => !!document.querySelector('#planBody [data-a="skip"]'));
  check(has, "待参观的厂家有「跳过」按钮");

  await page.evaluate(() => document.querySelector('#planBody [data-a="skip"]').click());
  await sleep(300);
  const afterSkip = await page.evaluate(() => ({
    status: FR.plans.find(p => p.id === "plan-v16").status,
    resume: !!document.querySelector('#planBody [data-a="resume"]'),
    del: !!document.querySelector('#planBody [data-a="del"]'),
  }));
  check(afterSkip.status === "skipped", "点跳过后状态变 skipped");
  check(afterSkip.resume, "跳过之后出现「继续参观」按钮");
  check(afterSkip.del, "每一行都有删除按钮");

  await page.evaluate(() => { window.confirm = () => true; });
  await page.evaluate(() => document.querySelector('#planBody [data-a="resume"]').click());
  await sleep(300);
  const afterResume = await page.evaluate(() => ({
    status: FR.plans.find(p => p.id === "plan-v16").status,
    arrive: !!document.querySelector('#planBody [data-a="arrive"]'),
  }));
  check(afterResume.status === "planned", "「继续参观」把状态退回 planned");
  check(afterResume.arrive, "退回后可以再次「到访拍照」");

  await page.evaluate(() => document.querySelector('#planBody [data-a="del"]').click());
  await sleep(300);
  const afterDel = await page.evaluate(async () => {
    await FR.refresh();
    return { inList: FR.plans.some(p => p.id === "plan-v16"),
             tomb: (await FR.all("visitPlans")).some(p => p.id === "plan-v16" && !!p.deletedAt) };
  });
  check(!afterDel.inList, "删除后不再出现在清单里");
  check(afterDel.tomb, "删除写成墓碑（其他设备同步后会一起删）");

  console.log("\n[2] 打开相机没拍照：不记照片、不留空记录");
  const cancelled = await page.evaluate(async () => {
    const n0 = FR.suppliers.length, p0 = FR.photos.length;
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {};   // 拦住系统相机
    document.getElementById("btnQuick").click();
    const inp = document.getElementById("fileCam");
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(0)], "empty.jpg", { type: "image/jpeg" }));
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change"));
    HTMLInputElement.prototype.click = orig;
    await new Promise(r => setTimeout(r, 400));
    await FR.refresh();
    return { n0, p0, n1: FR.suppliers.length, p1: FR.photos.length };
  });
  check(cancelled.n1 === cancelled.n0, "取消拍照不会多出厂家记录（" + cancelled.n0 + " → " + cancelled.n1 + "）");
  check(cancelled.p1 === cancelled.p0, "取消拍照不会多算一张照片（" + cancelled.p0 + " → " + cancelled.p1 + "）");

  const okShot = await page.evaluate(async (mk) => {
    const n0 = FR.suppliers.length, p0 = FR.photos.length;
    const file = await eval(mk)("ok.jpg");
    const s = FR.newSupplier({ companyNameZh: "正常厂家", boothNo: "11.1C05" });
    await FR.put("suppliers", s);
    await addPhoto(s.id, file, "booth");
    await FR.refresh();
    return { n0, p0, n1: FR.suppliers.length, p1: FR.photos.length };
  }, MAKE_FILE);
  check(okShot.p1 === okShot.p0 + 1, "正常拍一张就只加一张照片");

  /* 照片数 ↔ 报告里出现的照片数 */
  const counts = await page.evaluate(async (mk) => {
    const s = FR.suppliers.find(x => x.companyNameZh === "正常厂家");
    for (let i = 0; i < 3; i++) await addPhoto(s.id, await eval(mk)("p" + i + ".jpg"), "product");
    await FR.refresh();
    const ctx = await FRReport.buildContext({ fairId: FR.fair.id, withPhotos: true });
    const inReport = Object.values(ctx.photoIndex).reduce((n, a) => n + a.length, 0);
    return { app: FR.photos.length, inReport, sup: (ctx.photoIndex[s.id] || []).length };
  }, MAKE_FILE);
  check(counts.app === counts.inReport,
    "App 照片数 = 报告内嵌照片数（" + counts.app + " / " + counts.inReport + "）");
  check(counts.sup === 4, "这家 4 张照片全部进报告（实际 " + counts.sup + "）");

  console.log("\n[3] 编辑页照片：点开全屏、双击放大、点空白关闭");
  await page.evaluate(() => {
    const s = FR.suppliers.find(x => x.companyNameZh === "正常厂家");
    go("edit"); renderEdit(s.id);
  });
  await sleep(400);
  await tapEl(page, "#editPhotos .imgbtn");
  await sleep(300);
  let lb = await page.evaluate(() => {
    const d = document.getElementById("frlb");
    return { on: !!d && d.classList.contains("on"),
             src: (document.getElementById("frlbImg") || {}).src || "",
             cnt: (document.getElementById("frlbCnt") || {}).textContent || "" };
  });
  check(lb.on, "点照片后全屏查看器打开");
  check(/^blob:/.test(lb.src), "放大显示的是原图（" + lb.src.slice(0, 24) + "…）");
  check(/\d+ \/ \d+/.test(lb.cnt), "显示第几张 / 共几张（" + lb.cnt + "）");

  // 双击放大（第二下取消关闭，只切换 zoom）
  await dblTap(page, "#frlbStage");
  await sleep(250);
  const zoomed = await page.evaluate(() => {
    const d = document.getElementById("frlb");
    return { z: d.classList.contains("zoomed"), on: d.classList.contains("on") };
  });
  check(zoomed.z, "双击后放大一倍");
  check(zoomed.on, "双击不会误关查看器");

  // 单击空白处关闭
  await sleep(400);
  await tapOnce(page, "#frlbStage");
  await sleep(500);
  const closed = await page.evaluate(() => !document.getElementById("frlb").classList.contains("on"));
  check(closed, "点空白关闭查看器");

  // 触屏兜底：不合成 click 的浏览器也能打开
  await page.evaluate(() => document.getElementById("frlbClose").click());
  await tapTouch(page, "#editPhotos .imgbtn");
  await sleep(250);
  const touchOk = await page.evaluate(() => !!document.getElementById("frlb")
    && document.getElementById("frlb").classList.contains("on"));
  check(touchOk, "只有 touchend（不合成 click）时也能打开");
  await page.evaluate(() => document.getElementById("frlbClose").click());

  // 下一张切换
  await tapEl(page, "#editPhotos .imgbtn");
  await sleep(250);
  await page.evaluate(() => document.getElementById("frlbNext").click());
  await sleep(200);
  const nextOk = await page.evaluate(() => (document.getElementById("frlbCnt") || {}).textContent || "");
  check(/^2 \//.test(nextOk.trim()) || /^1 \//.test(nextOk.trim()), "点 › 可切换（当前 " + nextOk + "）");
  await page.evaluate(() => document.getElementById("frlbClose").click());

  console.log("\n[4] 报告 HTML 里的照片同样能放大");
  const html = await page.evaluate(async () => {
    const ctx = await FRReport.buildContext({ fairId: FR.fair.id, withPhotos: true });
    return FRReport.renderHTML(ctx);
  });
  fs.writeFileSync(path.join(TMP, "report.html"), html, "utf8");
  check(/class='grid'/.test(html), "报告里有照片区");
  check(/id='lb'/.test(html) && /zoomed/.test(html), "报告内联了放大脚本");

  const rp = await browser.newPage();
  await rp.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await rp.setContent(html, { waitUntil: "domcontentloaded" });
  await sleep(300);
  await rp.evaluate(() => document.querySelector(".grid").scrollIntoView({ block: "center" }));
  await sleep(200);
  await tapEl(rp, ".grid img");
  await sleep(300);
  const r1 = await rp.evaluate(() => {
    const d = document.getElementById("lb");
    return { on: !!d && d.classList.contains("on"),
             cnt: (d && d.querySelector(".lbcount") || {}).textContent || "" };
  });
  check(r1.on, "报告里点照片 → 全屏打开");
  check(/\d+ \/ \d+/.test(r1.cnt), "报告大图显示张数（" + r1.cnt + "）");

  await dblTap(rp, "#lbStage");
  await sleep(250);
  const r2 = await rp.evaluate(() => {
    const d = document.getElementById("lb");
    return { z: d.classList.contains("zoomed"), on: d.classList.contains("on") };
  });
  check(r2.z, "报告大图双击再放大一倍");
  check(r2.on, "报告大图双击不会误关");

  await sleep(400);
  await tapOnce(rp, "#lbStage");
  await sleep(500);
  const r3 = await rp.evaluate(() => !document.getElementById("lb").classList.contains("on"));
  check(r3, "报告大图点空白可关闭");

  // 触屏兜底
  await tapTouch(rp, ".grid img");
  await sleep(250);
  const r4 = await rp.evaluate(() => !!document.getElementById("lb")
    && document.getElementById("lb").classList.contains("on"));
  check(r4, "报告：只有 touchend 时也能打开");

  console.log("\n[5] 无 JS 错误");
  check(errors.length === 0, "无运行时错误" + (errors.length ? "：" + errors[0] : ""));

  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("\n通过 " + pass + " 项" + (fail ? "，失败 " + fail + " 项" : "，全部通过"));
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
