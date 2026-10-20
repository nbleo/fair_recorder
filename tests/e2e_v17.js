/* v1.7 行为联调（真浏览器）
   1) 评分维度改 Design / Quality / Details（每项 1–5 星）+ 旧六维数据迁移
   2) 展会「观展总结」多段文本 → 报告最后一项
   3) 每项评分带 Comments；联系人只必填姓名
   4) 拍摄名片（多张）+ 记录名片信息
   5) 亮点产品：每条多张照片 + 文字说明
   6) 点图片放大必须是原图（不能是 ? 占位）
   7) 导出按钮改为 HTML / DOCX，两者都能真的出文件
   用法: node tests/e2e_v17.js <url>
*/
const puppeteer = require("puppeteer");
const path = require("path");

const URL = process.argv[2] || "http://127.0.0.1:8765/index.html";
let fail = 0, pass = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log("  ok   " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 浏览器里造一张真 JPEG（canvas → Blob → File） */
const MAKE_FILE = `(async (name, w, h) => {
  const c = document.createElement("canvas"); c.width = w || 1200; c.height = h || 900;
  const x = c.getContext("2d");
  x.fillStyle = "#1F1FAF"; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#fff"; x.fillRect(60, 60, c.width - 120, c.height - 120);
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
  return new File([blob], name || "photo.jpg", { type: "image/jpeg" });
})`;

async function freshDb(page) {
  await page.evaluate(async () => {
    for (const st of ["photos", "suppliers", "visitPlans", "fairs"]) {
      for (const x of await FR.all(st)) await FR.del(st, x.id);
    }
    await FR.refresh();
    await FR.put("fairs", { id: "fair-v17", name: "V17 测试展", nameEn: "V17 Test Fair",
      city: "广州", venue: "展馆", area: "卫浴", phase: "Phase II", startDate: "2026-10-23",
      endDate: "2026-10-25", defaultHall: "A区", notes: "", summary: "", archived: false,
      lastPushAt: null, deletedAt: null, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString() });
    await FR.refresh();
    await FR.selectFair("fair-v17");
  });
}

(async () => {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId, { timeout: 30000 });
  await freshDb(page);

  /* ---------------- 1) 评分维度 ---------------- */
  console.log("\n[1] 评分改为 Design / Quality / Details");
  const dims = await page.evaluate(() => FR.consts.SCORE_DIMS.map((d) => d[0]));
  check(JSON.stringify(dims) === JSON.stringify(["design", "quality", "details"]),
    "评分维度就是这三项：" + dims.join(" / "));
  const wsum = await page.evaluate(() => {
    const w = FR.settings.weights;
    return { keys: Object.keys(w).sort().join(","), sum: Object.values(w).reduce((a, b) => a + b, 0) };
  });
  check(wsum.sum === 100, "默认权重合计 100%（实际 " + wsum.sum + "%）");
  check(wsum.keys === "design,details,quality", "权重字典已换成三项键：" + wsum.keys);

  await page.evaluate(() => go("settings"));
  await sleep(500);
  const setRows = await page.evaluate(() => ({
    n: document.querySelectorAll("#setWeights .score-row").length,
    labels: Array.from(document.querySelectorAll("#setWeights .lbl")).map((x) => x.textContent.trim()),
    preset: Array.from(document.querySelectorAll("#setWPreset .chip")).map((x) => x.textContent.trim()).join("/"),
    hasSummary: !!document.querySelector("#setSummaryTxt"),
  }));
  check(setRows.n === 3, "设置页只有三行权重（实际 " + setRows.n + " 行）");
  check(/Design/.test(setRows.labels.join(" ")) && /Quality/.test(setRows.labels.join(" "))
    && /Details/.test(setRows.labels.join(" ")), "权重行带英文名：" + setRows.labels.join(" | "));
  check(/外观优先/.test(setRows.preset) && !/合规优先/.test(setRows.preset),
    "预设换成三项口径：" + setRows.preset);
  check(setRows.hasSummary, "设置页有「观展总结」入口");

  /* 旧六维记录迁移 */
  const migrated = await page.evaluate(() => {
    const s = { score: { fit: 5, compliance: 4, quality: 3, price: 2, capacity: 5, communication: 4 } };
    const before = { ...s.score };
    const sc = FR.util.weightedScore(s, { design: 30, quality: 50, details: 20 });
    return { before, after: s.score, score: sc };
  });
  check(migrated.after.design === 5 && migrated.after.details === 4,
    "旧数据折算：design←fit, details←compliance（" + JSON.stringify(migrated.after) + "）");
  check(migrated.score != null, "迁移后能算出加权分：" + migrated.score);

  /* ---------------- 2) 观展总结 ---------------- */
  console.log("\n[2] 展会观展总结");
  await page.evaluate(() => go("fairs"));
  await sleep(300);
  await page.evaluate(() => { editCurrentFair(); });
  await sleep(400);
  const hasBox = await page.evaluate(() => !!document.querySelector("#fSummary"));
  check(hasBox, "展会编辑页有「观展总结」多行文本框");
  await page.evaluate(() => {
    const t = document.querySelector("#fSummary");
    t.value = "第一段：窄边框成为主流。\n\n第二段：待跟进 —— 超窄边框供应商要补证书范围。";
    document.querySelector("#fSave").click();
  });
  await sleep(600);
  const fairAfter = await page.evaluate(async () => {
    const f = await FR.get("fairs", "fair-v17");
    return f && f.summary;
  });
  check(/第一段：窄边框成为主流/.test(fairAfter || ""), "多段文本存进了展会记录");
  check(/\n\n/.test(fairAfter || ""), "段落分隔没有被压平");

  await page.evaluate(() => go("settings"));
  await sleep(500);
  const setTxt = await page.evaluate(() => ({
    txt: (document.querySelector("#setSummaryTxt") || {}).textContent,
    fair: FR.fair && FR.fair.summary,
  }));
  check(/窄边框成为主流/.test(setTxt.txt || ""), "设置页能看到观展总结");
  /* 导出的 ZIP 里必须带得上，否则电脑端脚本拿不到总结 */
  const bundleOut = await page.evaluate(async () => {
    const b = await FR.buildBundle("full");
    return { summary: (b.bundle.fair || {}).summary, photos: b.bundle.photos.length,
      hasHlField: b.bundle.photos.every((p) => "highlightId" in p) };
  });
  check(/窄边框成为主流/.test(bundleOut.summary || ""), "导出的 ZIP 里带着观展总结");
  check(bundleOut.hasHlField, "照片导出时带上了 highlightId（电脑端才能给亮点产品配图）");

  /* ---------------- 3) 三项评分 + Comments ---------------- */
  console.log("\n[3] 供应商评分与 Comments");
  const supId = await page.evaluate(async () => {
    const s = FR.newSupplier({ companyNameZh: "星评厂", companyNameEn: "Star Co", boothNo: "A-01",
      categories: ["shower_enclosure"] });
    await FR.put("suppliers", s);
    await FR.refresh();
    CUR = s.id; go("edit"); renderEdit(s.id);
    return s.id;
  });
  await sleep(500);
  const rowsInfo = await page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll("#editForm .score-row")).map((r) => r.dataset.d),
    notes: Array.from(document.querySelectorAll("#editForm [data-sn]")).map((r) => r.dataset.sn),
    stars: document.querySelectorAll('#editForm .score-row[data-d="design"] .star').length,
  }));
  check(rowsInfo.rows.join(",") === "design,quality,details", "编辑页只有三项评分：" + rowsInfo.rows.join(","));
  check(rowsInfo.notes.join(",") === "design,quality,details", "每项都带 Comments 框：" + rowsInfo.notes.join(","));
  check(rowsInfo.stars === 5, "每项 5 星级（实际 " + rowsInfo.stars + " 颗）");

  await page.evaluate(() => document.querySelector('#editForm .score-row[data-d="design"] .star[data-n="4"]').click());
  await sleep(400);
  const afterStar = await page.evaluate(async () => {
    document.querySelector('#editForm [data-sn="design"]').value = "壁厚 1.4mm，收口干净";
    document.querySelector('#editForm [data-sn="design"]').dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const s = await FR.get("suppliers", CUR);
    return { score: s.score, notes: s.scoreNotes };
  });
  check(afterStar.score.design === 4, "点第 4 颗星记为 4 分（实际 " + afterStar.score.design + "）");
  check(afterStar.notes.design === "壁厚 1.4mm，收口干净", "Comments 写进了 scoreNotes.design");

  /* 联系人只必填姓名 */
  const miss = await page.evaluate(() => {
    const s = { companyNameZh: "星评厂", contactName: "王先生", categories: ["shower_enclosure"], photoIds: ["x"] };
    return FR.util.missing(s);
  });
  check(miss.length === 0, "只有姓名没有手机 / 邮箱也算完整：" + JSON.stringify(miss));
  const missNoName = await page.evaluate(() => FR.util.missing(
    { companyNameZh: "星评厂", categories: ["shower_enclosure"], photoIds: ["x"] }));
  check(/联系人/.test(missNoName.join("")) && !/联系方式/.test(missNoName.join("")),
    "缺姓名仍要提示，且不再要求联系方式：" + missNoName.join("、"));

  /* ---------------- 3.5) 简介改名 / 型号移除 ---------------- */
  const labelTxt = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#editForm label")).map((x) => x.textContent.trim()));
  check(labelTxt.some((l) => l.indexOf("简介") >= 0),
    "「产品描述 / 亮点」已改名为「简介 / 公司简介」");
  check(!labelTxt.some((l) => l.indexOf("型号") >= 0), "「型号」输入项已从录入页移除");

  /* ---------------- 4) 拍摄名片 ---------------- */
  console.log("\n[4] 拍摄名片");
  const nc = await page.evaluate(async (mk) => {
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {};        // 拦住系统相机
    document.querySelector("#ncCam").click();
    const inp = document.getElementById("fileCam");
    const dt = new DataTransfer();
    dt.items.add(await eval(mk)("card1.jpg", 1400, 900));
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change"));
    HTMLInputElement.prototype.click = orig;
    await new Promise((r) => setTimeout(r, 900));
    return null;
  }, MAKE_FILE);
  await sleep(600);
  const nc1 = await page.evaluate(async () => {
    const s = await FR.get("suppliers", CUR);
    const ph = (await FR.all("photos")).filter((p) => p.supplierId === CUR && p.type === "namecard");
    return { n: ph.length, has: !!document.querySelector("#ncCam"), cards: (await FR.get("suppliers", CUR)).photoIds.length };
  });
  check(nc1.n === 1, "拍一张名片就存一张（实际 " + nc1.n + " 张）");
  check(await page.evaluate(() => !!document.querySelector("#ncCam")), "拍完仍在编辑页，可以继续拍第二张");

  await page.evaluate(async (mk) => {
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {};
    document.querySelector("#ncCam").click();
    const inp = document.getElementById("fileCam");
    const dt = new DataTransfer();
    dt.items.add(await eval(mk)("card2.jpg", 1400, 900));
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change"));
    HTMLInputElement.prototype.click = orig;
    await new Promise((r) => setTimeout(r, 900));
  }, MAKE_FILE);
  await sleep(600);
  const nc2 = await page.evaluate(async () => {
    const ph = (await FR.all("photos")).filter((p) => p.supplierId === CUR && p.type === "namecard");
    return {
      n: ph.length,
      inputs: document.querySelectorAll("#editForm [data-nc]").length,
      hasCam: !!document.getElementById("ncCam"),
      hasPick: !!document.getElementById("ncPick"),
    };
  });
  check(nc2.n === 2, "支持多张名片照片（实际 " + nc2.n + " 张）");
  check(nc2.hasCam && nc2.hasPick, "名片板块仍保留拍摄 / 相册入口");
  /* v1.8：手抄名片信息的输入框全部删掉，只留照片 */
  check(nc2.inputs === 0, "名片下的姓名 / 职位等手填项已移除（实际还剩 " + nc2.inputs + " 个）");

  /* 旧记录里的 namecard 字段仍要能读出并进导出（不能因为删了输入就把老数据丢了） */
  const ncCompat = await page.evaluate(async () => {
    const s = await FR.get("suppliers", CUR);
    s.namecard = Object.assign({}, s.namecard || {}, { name: "Klaus Meier", title: "Export Manager" });
    await FR.put("suppliers", s);
    await FR.refresh();
    const ctx = await FRReport.buildContext();
    const xl = await FRReport.toXLSX(ctx);
    /* Master 表里应该有 Card name 这一列，值就是老数据里的 Klaus Meier */
    const z = await JSZip.loadAsync(xl);
    const sheet = await z.file("xl/worksheets/sheet1.xml").async("string");
    return { hasKlaus: sheet.indexOf("Klaus Meier") >= 0 };
  });
  check(ncCompat.hasKlaus, "历史名片数据仍随导出一起出去（Card name 列有值）");

  /* ---------------- 5) 亮点产品 ---------------- */
  console.log("\n[5] 亮点产品");
  await page.evaluate(() => document.querySelector("#hlAdd").click());
  await sleep(500);
  const hl1 = await page.evaluate(async () => {
    const inp = document.querySelector('#editForm [data-ht]');
    inp.value = "Slimline 10mm 超窄边框";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    const note = document.querySelector('#editForm [data-hnote]');
    note.value = "边框做到 10mm，需确认 6mm 钢化是否配套";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const s = await FR.get("suppliers", CUR);
    return { n: s.highlights.length, t: (s.highlights[0] || {}).title, note: (s.highlights[0] || {}).note };
  });
  check(hl1.n === 1, "可以新增一条亮点产品");
  check(hl1.t === "Slimline 10mm 超窄边框" && /钢化/.test(hl1.note || ""), "标题与说明都写进 highlights");

  await page.evaluate(async (mk) => {
    const bid = document.querySelector("#editForm [data-hcam]").dataset.hcam;
    const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {};
    document.querySelector("#editForm [data-hcam]").click();
    const inp = document.getElementById("fileCam");
    const dt = new DataTransfer();
    dt.items.add(await eval(mk)("hl1.jpg", 1400, 900));
    dt.items.add(await eval(mk)("hl2.jpg", 1400, 900));
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change"));
    HTMLInputElement.prototype.click = orig;
    await new Promise((r) => setTimeout(r, 1200));
    return bid;
  }, MAKE_FILE);
  await sleep(800);
  const hl2 = await page.evaluate(async () => {
    const bid = await (async () => {
      const s = await FR.get("suppliers", CUR);
      return (s.highlights[0] || {}).id;
    })();
    const ph = (await FR.all("photos")).filter((p) => p.highlightId === bid);
    return { n: ph.length, thumbs: document.querySelectorAll("#editForm .hlph .ph").length };
  });
  check(hl2.n >= 1, "亮点产品支持挂多张照片（实际 " + hl2.n + " 张）");
  check(hl2.thumbs >= 1, "亮点照片在编辑页有缩略图：" + hl2.thumbs);

  /* ---------------- 6) 图片放大必须是原图 ---------------- */
  console.log("\n[6] 点图片放大显示原图");
  await page.evaluate(() => { renderEdit(CUR); });
  await sleep(600);
  await page.evaluate(() => {
    const b = document.querySelector("#editPhotos .imgbtn") || document.querySelector("#editForm .hlph .imgbtn");
    b.scrollIntoView({ block: "center" });
    b.click();
  });
  await sleep(900);
  const lb = await page.evaluate(async () => {
    const el = document.getElementById("frlb");
    const img = document.getElementById("frlbImg");
    const on = el && el.classList.contains("on");
    let loaded = false, w = 0;
    try {
      /* 等到图片真正解码完；naturalWidth=0 就是那个 "?" 占位图 */
      await new Promise((res, rej) => {
        if (img.complete && img.naturalWidth) { res(); return; }
        img.onload = res; img.onerror = rej;
        setTimeout(() => rej(new Error("timeout")), 5000);
      });
      loaded = true; w = img.naturalWidth;
    } catch (e) { /* 保持 loaded=false */ }
    return { on, loaded, w, src: String(img.getAttribute("src") || "").slice(0, 12) };
  });
  check(lb.on, "点击后灯箱已打开");
  check(lb.loaded && lb.w > 0, "放大的确是原图（naturalWidth=" + lb.w + "，src=" + lb.src + "…）");
  check(/^blob:/.test(lb.src), "大图用即时创建的 blob URL，不会被提前回收");

  /* ---------------- 7) 导出按钮 / DOCX ---------------- */
  console.log("\n[7] 导出与分享");
  await page.evaluate(() => go("report"));
  await sleep(900);
  const btns = await page.evaluate(() => ({
    html: (document.querySelector("#btnRpHtml") || {}).textContent || "",
    docx: (document.querySelector("#btnRpDocx") || {}).textContent || "",
    old: !!document.querySelector("#btnRpPreview"),
  }));
  check(/导出 \/ 分享 HTML 报告/.test(btns.html), "第一个按钮是「导出 / 分享 HTML 报告」：" + btns.html.trim());
  check(/导出 \/ 分享 DOCX 报告/.test(btns.docx), "第二个按钮是「导出 / 分享 DOCX 报告」：" + btns.docx.trim());
  check(!btns.old, "原来的「预览英文报告」按钮已移除");

  const shareOut = await page.evaluate(async () => {
    window.__shared = [];
    Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
    Object.defineProperty(navigator, "share", {
      value: async (d) => { window.__shared.push(d.files[0].name); }, configurable: true });
    document.querySelector("#btnRpDocx").click();
    await new Promise((r) => setTimeout(r, 4000));
    return { names: window.__shared, txt: (document.querySelector("#rpResult") || {}).textContent || "" };
  });
  check(shareOut.names.some((n) => /\.docx$/.test(n)),
    "点按钮真的生成并分享出 DOCX：" + shareOut.names.join(", "));
  check(/Supplier_Report_/.test(shareOut.txt), "结果区给出文件名");

  /* DOCX 内容必须包含三章 + 观展总结 */
  const docBody = await page.evaluate(async () => {
    const ctx = await FRReport.buildContext({ fairId: FR.fair.id, topN: 5, withPhotos: true });
    const blob = await FRReport.toDOCX(ctx);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const z = await JSZip.loadAsync(buf);
    const doc = await z.file("word/document.xml").async("string");
    const media = Object.keys(z.files).filter((n) => /^word\/media\/img\d+\.jpg$/.test(n));
    return { doc, media: media.length };
  });
  check(/1\. Supplier List/.test(docBody.doc), "DOCX 第 1 章 Supplier List");
  check(/2\. Supplier Catalogue/.test(docBody.doc), "DOCX 第 2 章 Supplier Catalogue");
  check(/3\. Fair Summary/.test(docBody.doc), "DOCX 第 3 章 Fair Summary");
  check(/窄边框成为主流/.test(docBody.doc), "观展总结排在 DOCX 最后一项");
  check(!/Executive Summary/.test(docBody.doc), "DOCX 已无 Executive Summary");
  check(docBody.media >= 1, "DOCX 内嵌了照片：" + docBody.media + " 张");

  /* ---------------- 收尾 ---------------- */
  const errClean = errors.filter((e) => !/favicon|404/i.test(e));
  check(errClean.length === 0, "无 JS 运行时错误" + (errClean.length ? "：" + errClean.join(" | ") : ""));

  console.log("\n" + (fail ? "v1.7 联调：有失败项" : "v1.7 联调：全部通过") + `（${pass} 通过 / ${fail} 失败）`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("崩溃：", e); process.exit(1); });
