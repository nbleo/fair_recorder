/* 展会删除 + 录入表单精简 回归测试
 *
 *   NODE_PATH=<node workspace>/node_modules node tests/e2e_fair_delete.js [baseUrl]
 *
 * 只做正确性检查（数据结构 / 删除语义 / 表单内容），不做视觉校验。
 */
const puppeteer = require("puppeteer");

const BASE = process.argv[2] || "http://127.0.0.1:8765/index.html";

const ok = (m) => console.log("  ok   " + m);
const bad = (m) => { console.log("  FAIL " + m); process.exitCode = 1; };
const check = (c, m) => (c ? ok(m) : bad(m));

(async () => {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto(BASE, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId, { timeout: 20000 });

  // ---------- 1) 表单精简 ----------
  const cats = await page.evaluate(() => FR.consts.CATEGORIES.map((c) => c[0]));
  check(cats.includes("smart_toilet"), "品类含 smart_toilet（智能马桶）");
  const catEn = await page.evaluate(() => {
    const c = FR.consts.CATEGORIES.find((x) => x[0] === "smart_toilet");
    return c && c[2];
  });
  check(catEn === "Smart Toilet", `智能马桶英文名为 Smart Toilet（实际 ${catEn}）`);

  await page.evaluate(async () => {
    const mk = (id, name, nameEn, s, e) => ({ id, name, nameEn, city: "", venue: "", area: "",
      phase: "", startDate: s, endDate: e, defaultHall: "A区", notes: "", archived: false,
      lastPushAt: null, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), deletedAt: null });
    const have = new Set((await FR.all("fairs")).map((f) => f.id));
    if (!have.has("fair-del-a")) await FR.put("fairs", mk("fair-del-a", "展会A", "Fair A", "2026-10-23", "2026-10-25"));
    if (!have.has("fair-del-b")) await FR.put("fairs", mk("fair-del-b", "展会B", "Fair B", "2026-05-26", "2026-05-29"));
    await FR.selectFair("fair-del-a");
    if (!FR.suppliers.length) {
      const s = FR.newSupplier({ companyNameZh: "测试厂家", contactName: "张三", phone: "13800138000" });
      await FR.put("suppliers", s);
      await FR.refresh();
    }
    go("edit");
    renderEdit(FR.suppliers[0].id);
  });
  await page.waitForSelector("#editForm", { timeout: 8000 });
  const form = await page.evaluate(() => document.getElementById("editForm").textContent);
  check(!/商务条件/.test(form), "录入页已无「商务条件」板块");
  check(!/合规资质/.test(form), "录入页已无「合规资质」板块");
  check(!/MOQ/.test(form), "录入页已无 MOQ 字段");
  check(/Smart Toilet/.test(form), "录入页品类里能选到「Smart Toilet」");
  check(/Scoring \(1–5 stars/.test(form), "评分区仍在（三项主观评分）");

  // ---------- 2) 照片不限张数（报告口径） ----------
  const photoN = await page.evaluate(async () => {
    const sid = FR.suppliers[0].id;
    // 造 5 张小图：1x1 jpeg
    const c = document.createElement("canvas"); c.width = 8; c.height = 8;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#0f0"; ctx.fillRect(0, 0, 8, 8);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.7));
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = "ph-del-" + i;
      await FR.put("photos", { id, fairId: FR.fair.id, supplierId: sid, type: "product",
        blob, thumbBlob: blob, size: blob.size, sha256: "", createdAt: new Date(Date.now() + i).toISOString() });
      ids.push(id);
    }
    const s = await FR.get("suppliers", sid);
    s.photoIds = ids; await FR.put("suppliers", s); await FR.refresh();
    const ctx2 = await window.FRReport.buildContext({
      fairId: FR.fair.id, all: false, topN: 3, withPhotos: true, preparedFor: "",
    });
    return Object.keys(ctx2.photoIndex[sid] || {}).length;
  });
  check(photoN === 5, `报告内嵌全部 5 张照片（不再截断为 3 张，实际 ${photoN}）`);

  // ---------- 3) 三重确认：任一关不通过都不删 ----------
  const gate = await page.evaluate(async () => {
    const id = FR.fair.id;
    const res = {};
    const realConfirm = window.confirm, realPrompt = window.prompt;
    // a) 第一步点取消
    window.confirm = () => false;
    await FR.deleteFairFlow(id);
    res.step1 = (await FR.all("fairs")).find((f) => f.id === id).deletedAt === null;
    // b) 名字输错
    window.confirm = () => true; window.prompt = () => "打错的名字";
    await FR.deleteFairFlow(id);
    res.step2 = (await FR.all("fairs")).find((f) => f.id === id).deletedAt === null;
    // c) 最后一步点取消
    window.prompt = () => "展会A";
    let n = 0; window.confirm = () => (++n < 2);   // 第一次 true，第二次 false
    await FR.deleteFairFlow(id);
    res.step3 = (await FR.all("fairs")).find((f) => f.id === id).deletedAt === null;
    window.confirm = realConfirm; window.prompt = realPrompt;
    return res;
  });
  check(gate.step1, "第 1 关取消 → 未删除");
  check(gate.step2, "第 2 关展会名输错 → 未删除");
  check(gate.step3, "第 3 关取消 → 未删除");

  // ---------- 4) 三关全过：本机删除 + 墓碑 ----------
  const del = await page.evaluate(async () => {
    const id = FR.fair.id;
    const before = await FR.fairStats(id);
    const realConfirm = window.confirm, realPrompt = window.prompt;
    window.confirm = () => true; window.prompt = () => "展会A";
    await FR.deleteFairFlow(id);
    window.confirm = realConfirm; window.prompt = realPrompt;
    const raw = await FR.all("fairs");
    const tomb = raw.find((f) => f.id === id);
    const other = raw.find((f) => f.id === "fair-del-b");
    const sup = (await FR.all("suppliers")).filter((s) => s.fairId === id);
    const phs = (await FR.all("photos")).filter((p) => p.fairId === id);
    return {
      before,
      tombstoneKept: !!tomb && !!tomb.deletedAt,
      tombstoneInList: FR.fairs.some((f) => f.id === id),
      otherAlive: !!other && !other.deletedAt,
      supDeleted: sup.length === 0 || sup.every((s) => !!s.deletedAt),
      photosGone: phs.length === 0,
      currentIsOther: FR.fair && FR.fair.id === "fair-del-b",
    };
  });
  check(del.before.suppliers === 1 && del.before.photos === 5,
    `删除前统计到 1 条记录 / 5 张照片（实际 ${del.before.suppliers}/${del.before.photos}）`);
  check(del.tombstoneKept, "展会保留为墓碑记录（deletedAt 已写，可同步给其他设备）");
  check(!del.tombstoneInList, "已删除展会不再出现在展会列表");
  check(del.supDeleted, "展会下的记录被打上墓碑（同步后其他设备也会删）");
  check(del.photosGone, "照片被物理删除，立刻释放空间");
  check(del.otherAlive, "另一个展会不受影响");
  check(del.currentIsOther, "删除后自动切到一个还活着的展会");

  // ---------- 5) 展会列表上有删除入口 ----------
  await page.evaluate(() => go("fairs"));
  await new Promise((r) => setTimeout(r, 400));
  const hasBtn = await page.evaluate(() => !!document.querySelector("#fairBody [data-del]"));
  check(hasBtn, "展会列表每行都有 🗑 删除按钮");

  // ---------- 6) sync.js 侧的墓碑入口存在 ----------
  const api = await page.evaluate(() => ({
    tombstone: typeof (window.FRSync && window.FRSync.pushTombstone) === "function",
    local: typeof (window.FR && window.FR.deleteFairLocal) === "function",
  }));
  check(api.tombstone, "FRSync.pushTombstone 已暴露（多端删除靠它）");
  check(api.local, "FR.deleteFairLocal 已暴露（收到云端墓碑时调用）");

  await browser.close();
  console.log("");
  if (errors.length) {
    console.log("页面错误：");
    errors.slice(0, 10).forEach((e) => console.log("   " + e));
    process.exitCode = 1;
  } else {
    console.log("无 JS 运行时错误");
  }
})().catch((e) => { console.error("fair delete test failed:", e); process.exit(1); });
