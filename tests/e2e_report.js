/* 手机端报告生成联调：真浏览器 → 录数据 → 生成 HTML / XLSX / CSV → 校验内容。
 *
 *   NODE_PATH=<node workspace>/node_modules node tests/e2e_report.js
 *
 * 只做正确性检查（英文文案、评分、分层、照片内嵌、xlsx 结构），不做视觉校验。
 * 下载目录用 CDP 接管，避免依赖浏览器的下载行为。
 */
const puppeteer = require("puppeteer");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "app");
const PORT = 8930 + Math.floor(Math.random() * 60);
const DOWNLOADS = path.join(ROOT, ".tmp_dl_report");

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });

  const server = await serve();
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });
  page.on("dialog", (d) => d.accept());

  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  console.log("stage: goto done");
  const cdp = await page.createCDPSession();
  await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId, { timeout: 20000 });
  console.log("stage: FR ready");
  await page.waitForFunction(() => !!window.FRReport, { timeout: 10000 });
  console.log("stage: FRReport ready");
  ok("报告模块已挂载 window.FRReport");

  console.log("stage: 1 build fair");
  await page.evaluate(async () => {
    const fs = await FR.all("fairs");
    if (!fs.some((x) => /RPT/.test(x.nameEn || ""))) {
      /* 走 UI 新建，确保新建流程本身没问题 */
      go("fairs");
      document.getElementById("btnFairNew").click();
    }
  });
  console.log("stage: fairs screen");
  await page.waitForSelector("#fName", { visible: true, timeout: 8000 });
  for (const [sel, v] of [["#fName", "报告联调展"], ["#fNameEn", "RPT Test Fair"],
                          ["#fVenue", "Test Hall"], ["#fCity", "Guangzhou"],
                          ["#fSummary", "第一段：淋浴房整体做的是窄边框，型材壁厚普遍到 1.2–1.5mm。\n\n第二段：待跟进 —— 超窄边框供应商需补 KTW 证书范围。"]]) {
    const el = await page.$(sel);
    if (!el) continue;
    await el.click({ clickCount: 3 });
    await page.evaluate((s) => { document.querySelector(s).value = ""; }, sel);
    await el.type(v);
  }
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
    set("fStart", "2026-10-23"); set("fEnd", "2026-10-25");
  });
  await page.evaluate(() => document.getElementById("fSave").click());
  await sleep(600);
  await page.evaluate(async () => {
    const fs = await FR.all("fairs");
    const f = fs.find((x) => /RPT/.test(x.nameEn || ""));
    if (f) await FR.selectFair(f.id);
  });
  await sleep(400);

  const fairName = await page.evaluate(() => (FR.fair && (FR.fair.nameEn || FR.fair.name)) || "");
  check(/RPT/.test(fairName), "展会已建并选中：" + fairName);

  /* ---------- 2) 录入两家（含评分与合规） ---------- */
  await page.evaluate(async () => {
    const mk = async (zh, en, booth, sc, comp, extra) => {
      const extra0 = extra || {};
      const sn = extra0.scoreNotes || {}, nc = extra0.namecard || {}, hl = extra0.highlights || [];
      const base = {
        id: FR.uid(), fairId: FR.fair.id, source: "walk_in",
        companyNameZh: zh, companyNameEn: en, boothNo: booth, hall: "A区", area: "卫浴设备",
        contactName: "Mr. Test", contactTitle: "Sales", phone: "+86 138 0000", email: "t@example.com",
        categories: ["shower_enclosure"], productDetails: "Test product line",
        moqValue: 100, moqUnit: "sets", priceMin: 120, priceMax: 180, currency: "USD",
        priceUnit: "set", incoterm: "FOB", leadTimeDays: 35,
        capacityValue: 5000, capacityUnit: "sets/month",
        exportMarkets: ["Germany 德国"], euGermanyExperience: "Yes",
        compliance: {}, score: sc, scoreNotes: sn, photoIds: [],
        namecard: nc, highlights: hl,
        followUpStatus: "docs", nextAction: "Send intro email", nextActionDate: "2026-11-05",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
      };
      for (const c of FR.consts.COMPLIANCE) base.compliance[c[0]] = { status: "unknown", certNo: "", note: "" };
      for (const k in comp) base.compliance[k] = { status: comp[k], certNo: "", note: "" };
      await FR.put("suppliers", base);
      return base.id;
    };
    window.__ids = [];
    /* v1.7：评分改三项 + 每项 Comments；另加名片信息与一条亮点产品 */
    window.__ids.push(await mk("甲厂", "Alpha Sanitary", "A-01",
      { design: 5, quality: 4, details: 5 },
      { CE: "copy_received", EN14428: "document_seen" },
      {
        scoreNotes: {
          design: "型材壁厚 1.4mm，边框收口干净",
          quality: "封边与装配一致性好，样品没有明显色差",
          details: "铰链自带缓冲，磁条贴合好",
        },
        namecard: { name: "Mr. Test", title: "Sales", mobile: "+86 138 0000",
          email: "t@example.com", address: "Guangzhou" },
        highlights: [{ id: FR.uid(), title: "超窄边框系列 Slimline 1.0",
          note: "边框做到 10mm，需确认 6mm 钢化是否配套", createdAt: new Date().toISOString() }],
      }));
    window.__ids.push(await mk("乙厂", "Beta Glass", "A-02",
      { design: 3, quality: 3, details: 2 },
      { EN12150: "not_available" },
      { scoreNotes: { design: "造型偏老" }, namecard: {}, highlights: [] }));
    await FR.refresh();
  });
  const nSup = await page.evaluate(() => FR.suppliers.length);
  check(nSup === 2, "录入 2 家供应商：" + nSup);

  /* 给第一家加三张照片：一张产品、一张名片、一张亮点产品配图（用 canvas 造真 JPEG） */
  await page.evaluate(async () => {
    const mkJpg = async () => {
      const c = document.createElement("canvas"); c.width = 600; c.height = 400;
      const g = c.getContext("2d"); g.fillStyle = "#22d3a6"; g.fillRect(0, 0, 600, 400);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
      return { big: await FR.compress(blob, 1600, 0.8), thumb: await FR.compress(blob, 320, 0.7) };
    };
    const sup = await FR.get("suppliers", window.__ids[0]);
    const add = async (type, highlightId) => {
      const { big, thumb } = await mkJpg();
      const p = { id: FR.uid(), fairId: FR.fair.id, supplierId: sup.id, type,
        highlightId: highlightId || null,
        blob: big, thumbBlob: thumb, w: 600, h: 400, size: big.size,
        sha256: await FR.sha256Hex(big), createdAt: new Date().toISOString() };
      await FR.put("photos", p);
      sup.photoIds.push(p.id);
    };
    sup.photoIds = [];
    /* 3 张普通照片会让 Booth Photos 走三列并排，正好用来验版面；
       名片 / 亮点各 1 张，各自回到单列布局。 */
    await add("product");
    await add("product");
    await add("product");
    await add("namecard");
    await add("highlight", (sup.highlights[0] || {}).id);
    await FR.put("suppliers", sup);
    await FR.refresh();
  });
  const nPhoto = await page.evaluate(() => FR.photos.length);
  check(nPhoto === 5, "已存 5 张照片（产品参数 ×3 / 名片 / 亮点）：" + nPhoto);

  /* ---------- 3) 进报告页 ---------- */
  await page.evaluate(() => go("report"));
  await page.waitForSelector("#rpSummary", { timeout: 8000 });
  await sleep(700);
  const summary = await page.$eval("#rpSummary", (el) => el.textContent.replace(/\s+/g, " ").trim());
  check(/Records\s*2\b/.test(summary), "概览显示记录数：" + summary.slice(0, 60));
  check(/Photos\s*5\b/.test(summary), "概览显示照片数（产品参数 ×3 / 名片 / 亮点各 1 张）");

  /* 设置抬头 */
  await page.evaluate(() => {
    const el = document.getElementById("rpFor");
    el.value = "Schulte – Shower enclosure sourcing";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);

  /* ---------- 4) 生成 HTML 并在页面内校验 ---------- */
  const html = await page.evaluate(async () => {
    const ctx = await FRReport.buildContext({
      fairId: FR.fair.id, topN: 5, withPhotos: true,
      preparedFor: document.getElementById("rpFor").value,
    });
    window.__ctx = ctx;
    return FRReport.renderHTML(ctx);
  });
  fs.writeFileSync(path.join(DOWNLOADS, "report.html"), html, "utf8");

  check(/Factory Report — RPT Test Fair/.test(html), "HTML 封面标题正确");
  check(/Prepared for: Schulte/.test(html), "HTML 封面含抬头 Prepared for");
  /* v1.7：只剩三章 —— Supplier List / Supplier Catalogue / Fair Summary */
  check(/1\. Factory List/.test(html), "HTML 含第 1 章 Factory List");
  check(/Factories recorded/.test(html), "Factory List 保留总数统计");
  /* v1.9：第 1 章不再是孤零零一个总数，要列出每家供应商 */
  check(/<table class='list'>/.test(html), "Factory List 含工厂明细表");
  check(/Booth \/ Hall/.test(html) && /Categories/.test(html), "明细表含 Booth / Hall 与 Categories 列");
  const listRowsHtml = (html.match(/<tr><td>\d+<\/td>/g) || []).length;
  check(listRowsHtml === 2, "明细表逐家列出两家供应商（实际 " + listRowsHtml + " 行）");
  check(/Alpha Sanitary \(甲厂\)/.test(html.split("2. Factory Catalogue")[0]),
    "公司名出现在第 1 章明细表里");
  check(/Mr\. Test \/ Sales/.test(html.split("2. Factory Catalogue")[0]),
    "明细表含联系人姓名与职位");
  check(!/Executive Summary/.test(html), "HTML 已删除 Executive Summary");
  check(!/Scope &amp; Methodology/.test(html), "HTML 已删除 Scope & Methodology");
  check(/2\. Factory Catalogue/.test(html), "HTML 含工厂目录");
  check(/3\. Fair Summary/.test(html), "HTML 含观展总结章节");
  /* v1.6：报告只保留 1 / 2 / 3 三章 */
  check(!/Comparison Matrix/.test(html), "HTML 已删除第 4 章 对比矩阵");
  check(!/Key Recommendations/.test(html), "HTML 已删除第 5 章 重点推荐");
  check(!/Next Steps/.test(html), "HTML 已删除第 6 章 跟进");
  check(!/Appendix/.test(html), "HTML 已删除第 7 章 附录");
  check(!/Still draft|Planned but not visited|Photos captured|Planned \/ walk-in/.test(html),
    "Executive Summary 已删除 draft / planned / photos 统计");
  check(!/Scoring weights/.test(html), "Scoring weights 章节已删除");
  check(!/MOQ \/ Price \/ Lead time/.test(html), "目录已删除 MOQ / Price / Lead time");
  check(!/<span class='k'>Compliance<\/span>/.test(html), "目录已删除 Compliance 行");
  check(/Alpha Sanitary \(甲厂\)/.test(html), "公司名中英并列");
  check(/Shortlist/.test(html), "高分组进入 Shortlist");
  /* 每项评分带 Comments */
  const dimCount = (html.match(/<tr><td>(Design|Quality|Details)<\/td>/g) || []).length;
  check(dimCount === 6, "两家供应商的三项评分 + 评语都输出了（实际 " + dimCount + " 行）");
  check(/<th>Comments<\/th>/.test(html), "评分表含 Comments 列");
  check(/型材壁厚 1.4mm/.test(html), "Design 的 Comments 原样进报告");
  check(/☆/.test(html), "星级以 ★/☆ 呈现");
  /* 名片 / 亮点产品各自成块 */
  check(/Name card/.test(html) && /Mr\. Test/.test(html), "名片信息进报告");
  check(/Highlight products/.test(html) && /超窄边框系列 Slimline 1\.0/.test(html), "亮点产品进报告");
  const ncGrid = (html.match(/alt='namecard'/g) || []).length;
  check(ncGrid === 1, "名片照片单独成片（实际 " + ncGrid + " 张）");
  /* Booth Photos：亮点产品之外的其余照片单独成一栏，排在 Highlight products 之后 */
  check(/Booth Photos/.test(html), "HTML 含独立 Booth Photos 板块");
  const iHl = html.indexOf("Highlight products");
  const iBooth = html.indexOf("Booth Photos");
  check(iHl >= 0 && iBooth > iHl, "Booth Photos 排在 Highlight products 之后");
  const boothImgs = (html.slice(iBooth).match(/alt='product'/g) || []).length;
  check(boothImgs === 3, "三张普通照片都落到 Booth Photos（实际 " + boothImgs + " 张）");
  /* 观展总结作为最后一项 */
  const tail = html.slice(html.indexOf("3. Fair Summary"));
  check(/淋浴房整体做的是窄边框/.test(tail), "观展总结第一段排在最后一项");
  check(/超窄边框供应商需补 KTW/.test(tail), "观展总结第二段按段落输出");
  check(/data:image\/jpeg;base64,/.test(html), "照片以 data URL 内嵌");
  check(/Print \/ Save as PDF/.test(html), "报告内含打印按钮");
  check(!/undefined/.test(html.replace(/undefined-/g, "")), "HTML 没有 undefined 泄漏");

  const scoreOk = await page.evaluate(() => {
    const s = window.__ctx.suppliers.find((x) => x._company.indexOf("Alpha") >= 0);
    return s && s._score > 85 && s._tier === "Shortlist";
  });
  check(scoreOk, "加权评分与分层正确（Alpha 应为 Shortlist >85）");

  /* ---------- 5) XLSX ---------- */
  /* XLSX 在浏览器里生成；结构校验也放回浏览器做（那里有 vendor 的 JSZip） */
  const xlsx = await page.evaluate(async () => {
    const blob = await FRReport.toXLSX(window.__ctx);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    const z = await JSZip.loadAsync(buf);
    const names = Object.keys(z.files);
    return {
      b64: btoa(s),
      head: String.fromCharCode(buf[0]) + String.fromCharCode(buf[1]),
      names,
      sheet1: await z.file("xl/worksheets/sheet1.xml").async("string"),
      workbook: await z.file("xl/workbook.xml").async("string"),
      types: await z.file("[Content_Types].xml").async("string"),
    };
  });
  const xlsxBuf = Buffer.from(xlsx.b64, "base64");
  fs.writeFileSync(path.join(DOWNLOADS, "report.xlsx"), xlsxBuf);
  check(xlsx.head === "PK", "XLSX 是合法 zip（PK 头）");
  check(xlsx.names.includes("xl/workbook.xml"), "XLSX 含 workbook.xml");
  check(xlsx.names.includes("xl/worksheets/sheet1.xml") && xlsx.names.includes("xl/worksheets/sheet2.xml"),
    "XLSX 含两个工作表：" + xlsx.names.filter((n) => /sheet\d/.test(n)).join(", "));
  check(xlsx.names.includes("xl/styles.xml"), "XLSX 含 styles.xml");
  check(/Alpha Sanitary/.test(xlsx.sheet1) && /Beta Glass/.test(xlsx.sheet1), "sheet1 含两家供应商");
  check(/Factories/.test(xlsx.workbook) && /Category Comparison/.test(xlsx.workbook), "工作表名正确");
  check(/spreadsheetml.sheet.main/.test(xlsx.types), "Content_Types 正确");
  check(/Design Comments|Design comments/.test(xlsx.sheet1), "Excel 含评分评语列");
  check(/Highlight products/.test(xlsx.sheet1) && /Card name/.test(xlsx.sheet1), "Excel 含名片与亮点产品列");

  /* ---------- 5b) DOCX ---------- */
  const docx = await page.evaluate(async () => {
    const blob = await FRReport.toDOCX(window.__ctx);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    const z = await JSZip.loadAsync(buf);
    const names = Object.keys(z.files);
    return {
      b64: btoa(s), size: buf.length,
      head: String.fromCharCode(buf[0]) + String.fromCharCode(buf[1]),
      names,
      doc: await z.file("word/document.xml").async("string"),
      rels: await z.file("word/_rels/document.xml.rels").async("string"),
      types: await z.file("[Content_Types].xml").async("string"),
      styles: await z.file("word/styles.xml").async("string"),
      core: await z.file("docProps/core.xml").async("string"),
    };
  });
  fs.writeFileSync(path.join(DOWNLOADS, "report.docx"), Buffer.from(docx.b64, "base64"));
  check(docx.head === "PK", "DOCX 是合法 zip（PK 头）");
  check(docx.names.includes("word/document.xml"), "DOCX 含 word/document.xml");
  check(docx.names.includes("word/styles.xml"), "DOCX 含 styles.xml");
  check(/wordprocessingml.document.main/.test(docx.types), "DOCX Content_Types 正确");
  check(/<dc:title>RPT Test Fair<\/dc:title>/.test(docx.core), "DOCX 核心属性写了展会名");
  const media = docx.names.filter((n) => /^word\/media\/img\d+\.jpg$/.test(n));
  check(media.length === 5, "五张照片都嵌进了 DOCX（实际 " + media.length + " 个 media：" + media.join(",") + "）");
  const imgRels = (docx.rels.match(/Type="[^"]*\/image"/g) || []).length;
  check(imgRels === 5, "图片关系数量正确（实际 " + imgRels + "）");
  check(/<pic:pic>/.test(docx.doc), "DOCX 用 DrawingML 内嵌图片");
  check(/1\. Factory List/.test(docx.doc), "DOCX 含 1. Factory List");
  check(/2\. Factory Catalogue/.test(docx.doc), "DOCX 含 2. Factory Catalogue");
  check(/3\. Fair Summary/.test(docx.doc), "DOCX 含 3. Fair Summary");
  check(!/Executive Summary/.test(docx.doc), "DOCX 已删除 Executive Summary");
  check(!/Scope &amp; Methodology/.test(docx.doc), "DOCX 已删除 Scope & Methodology");
  check(/Factories recorded/.test(docx.doc), "DOCX 保留总数统计");
  /* v1.9：DOCX 第 1 章同样是明细表，且与 HTML 同口径 */
  check(/Booth \/ Hall/.test(docx.doc), "DOCX 明细表含 Booth / Hall 列");
  const firstTbl = docx.doc.split("<w:tbl>")[1] || "";
  check((firstTbl.match(/<w:gridCol/g) || []).length === 6,
    "DOCX 第 1 章表格为 6 列（实际 " + (firstTbl.match(/<w:gridCol/g) || []).length + " 列）");
  check(/Alpha Sanitary/.test(firstTbl), "DOCX 明细表逐家列出供应商");
  check(/型材壁厚 1.4mm/.test(docx.doc), "DOCX 含评分评语");
  check(/超窄边框系列 Slimline 1\.0/.test(docx.doc), "DOCX 含亮点产品");
  check(/Booth Photos/.test(docx.doc), "DOCX 含独立 Booth Photos 板块");
  check(docx.doc.indexOf("Booth Photos") > docx.doc.indexOf("Highlight products"),
    "DOCX 里 Booth Photos 排在 Highlight products 之后");
  /* 排版：不再逐节硬分页；照片改用隐形表格横向并排 */
  const brk = (docx.doc.match(/<w:br w:type="page"\/>/g) || []).length;
  check(brk === 0, "DOCX 不再插硬分页（实际 " + brk + " 处，短章节不再白占整页）");
  const tblBlocks = docx.doc.split("<w:tbl>").slice(1)
    .filter((b) => b.indexOf("<w:drawing>") >= 0 && b.indexOf("</w:tbl>") >= 0);
  check(tblBlocks.length >= 3, "照片用隐形表格承载（名片 / 亮点 / Booth 各一组，实际 " + tblBlocks.length + " 组）");
  const threeCol = tblBlocks.filter((b) => (b.match(/<w:gridCol /g) || []).length === 3);
  check(threeCol.length >= 1, "三张 Booth Photos 排成三列（实际 " + threeCol.length + " 组三列表格）");
  check(/<w:tblLayout w:type="fixed"\/>/.test(docx.doc), "表格用固定布局，列宽不会被内容撑歪");
  check(/淋浴房整体做的是窄边框/.test(docx.doc), "DOCX 含观展总结");
  check(/<w:pStyle w:val="Heading1"\/>/.test(docx.doc), "DOCX 用了标题样式");
  check(!/undefined/.test(docx.doc), "DOCX 没有 undefined 泄漏");

  /* ---------- 6) CSV ---------- */
  const csv = await page.evaluate(() => FRReport.toCSV(window.__ctx, "master"));
  fs.writeFileSync(path.join(DOWNLOADS, "report.csv"), csv, "utf8");
  check(csv.charCodeAt(0) === 0xFEFF, "CSV 带 UTF-8 BOM（Excel 不乱码）");
  check(/Alpha Sanitary/.test(csv) && /Beta Glass/.test(csv), "CSV 含两家供应商");
  const csvCompare = await page.evaluate(() => FRReport.toCSV(window.__ctx, "compare"));
  check(/Shower Enclosure/.test(csvCompare), "CSV 对比表含英文品类名");

  /* ---------- 7) 走 UI：点按钮真的能生成 ----------
     桌面/无头 Chrome 的 navigator.share 会一直挂起等用户，这里替身成立即完成，
     既覆盖分享路径又不会把测试吊死。 */
  await page.evaluate(() => {
    window.__shared = [];
    Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
    Object.defineProperty(navigator, "share", {
      value: async (d) => { window.__shared.push(d.files[0].name); }, configurable: true,
    });
  });

  await page.evaluate(() => document.getElementById("btnRpHtml").click());
  await page.waitForFunction(() => /Created/.test(document.getElementById("rpResult").textContent), { timeout: 15000 })
    .catch(() => {});
  const res1 = await page.$eval("#rpResult", (el) => el.textContent.replace(/\s+/g, " ").trim());
  check(/Created Factory_Report_.*\.html/.test(res1), "点「导出 HTML」有结果：" + res1.slice(0, 46));

  await page.evaluate(() => document.getElementById("btnRpXlsx").click());
  await page.waitForFunction(() => /\.xlsx/.test(document.getElementById("rpResult").textContent), { timeout: 15000 })
    .catch(() => {});
  const res2 = await page.$eval("#rpResult", (el) => el.textContent.replace(/\s+/g, " ").trim());
  check(/Created Factory_Report_.*\.xlsx/.test(res2), "点「导出 Excel」有结果");

  await page.evaluate(() => document.getElementById("btnRpCsv").click());
  await page.waitForFunction(() => /\.csv/.test(document.getElementById("rpResult").textContent), { timeout: 15000 })
    .catch(() => {});
  const res3 = await page.$eval("#rpResult", (el) => el.textContent.replace(/\s+/g, " ").trim());
  check(/\.csv/.test(res3), "点「导出 CSV」有结果");

  const shared = await page.evaluate(() => window.__shared);
  check(shared.length === 3 && shared.every((n) => /^Factory_Report_/.test(n)),
    "三次导出都走分享：" + shared.join(", "));

  /* 无分享能力时（桌面浏览器）必须退回下载，不能卡死 */
  const fallback = await page.evaluate(async () => {
    Object.defineProperty(navigator, "canShare", { value: () => false, configurable: true });
    const t0 = Date.now();
    await FRReport.share(new Blob(["x"]), "fallback.txt", "text/plain");
    return Date.now() - t0;
  });
  check(fallback < 3000, "无分享能力时立即降级为下载（" + fallback + "ms）");

  /* ---------- 8) 全部展会合并口径 ---------- */
  const allCtx = await page.evaluate(async () => {
    const ctx = await FRReport.buildContext({ all: true, topN: 3, withPhotos: false });
    return { n: ctx.suppliers.length, fairs: ctx.fairs.length };
  });
  check(allCtx.n >= 2, "全部展会合并口径可用：" + allCtx.n + " 家 / " + allCtx.fairs + " 个展会");

  /* ---------- 9) 无 JS 错误 ---------- */
  check(errors.length === 0, "无 JS 错误" + (errors.length ? "：" + errors.slice(0, 3).join(" | ") : ""));

  await browser.close();
  server.close();
  console.log(process.exitCode ? "\n报告联调：有失败项" : "\n报告联调：全部通过");
})().catch((e) => { console.error("崩溃：", e); process.exitCode = 1; });
