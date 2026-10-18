/* 多终端同步联调：两台"设备"用同一个 GitHub 账号访问同一份数据。
 *
 *   GH_TOKEN=<pat> NODE_PATH=<node workspace>/node_modules node tests/e2e_multidevice.js
 *
 * 两个浏览器上下文各有独立 IndexedDB，等价于两台手机：
 *   A 建展会 + 录入 + 照片 → 备份
 *   B 全新设备 → 拉取云端全部展会 → 应看到同样的展会/记录/照片/权重
 *   B 改一条 → 备份；A 双向同步 → 应拿到 B 的改动
 *
 * 只做正确性检查，不做视觉校验。
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

/* 打开一台"设备"，并完成云配置 */
async function newDevice(browser, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 414, height: 896, deviceScaleFactor: 2 });
  page.on("dialog", (d) => d.accept());           // confirm 一律确认
  const errors = [];
  page.on("pageerror", (e) => errors.push(`[${label}] pageerror: ` + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${label}] console: ` + m.text());
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId,
    { timeout: 20000 });
  return { ctx, page, errors };
}

async function configure(page, token) {
  await page.evaluate(() => go("sync"));
  await page.waitForSelector("#syToken", { timeout: 8000 });
  await page.evaluate((o, r, t) => {
    document.getElementById("syOwner").value = o;
    document.getElementById("syRepo").value = r;
    document.getElementById("syBranch").value = "main";
    document.getElementById("syRoot").value = "users";
    document.getElementById("syToken").value = t;
  }, OWNER, REPO, token);
  /* 同步页的按钮是在进入页面时才绑定的，点早了等于没点 */
  await page.waitForFunction(() => {
    const el = document.getElementById("sySave");
    return !!(el && el.onclick);
  }, { timeout: 15000, polling: 200 });
  await page.evaluate(() => document.getElementById("sySave").click());
  await page.waitForFunction(async () => {
    const kv = await FR.getKV("gh", null);
    return !!(kv && kv.login);
  }, { timeout: 25000, polling: 400 });
}

(async () => {
  if (!TOKEN) { console.error("set GH_TOKEN first"); process.exit(2); }
  const server = await serve();
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  let fairId = null;

  try {
    /* ---------- 设备 A：建展会、录入、拍照、备份 ---------- */
    const A = await newDevice(browser, "A");
    await A.page.evaluate(() => { go("fairs"); });
    await A.page.evaluate(() => {
      const btn = document.querySelector("#btnFairNew"); btn.click();
    });
    await A.page.waitForSelector("#fName", { visible: true });
    await A.page.type("#fName", "多设备同步测试");
    await A.page.type("#fNameEn", "Multi-Device Sync Check");
    await A.page.evaluate(() => {
      document.querySelector("#fStart").value = "2026-10-23";
      document.querySelector("#fEnd").value = "2026-10-25";
    });
    await A.page.evaluate(() => document.querySelector("#fSave").click());
    await new Promise((r) => setTimeout(r, 500));
    fairId = await A.page.evaluate(() => FR.fair && FR.fair.id);

    // 自定义权重（用于验证权重随同步传播）
    await A.page.evaluate(async () => {
      await FR.setWeights({ fit: 30, compliance: 30, quality: 10, price: 10, capacity: 10, communication: 10 });
    });

    for (const [zh, en, booth] of [["甲厂", "Factory Alpha", "MD-01"], ["乙厂", "Factory Beta", "MD-02"]]) {
      await A.page.evaluate(() => go("home"));
      await new Promise((r) => setTimeout(r, 200));
      await A.page.evaluate(() => document.querySelector("#btnManual").click());
      await A.page.waitForSelector('#editForm input[data-k="companyNameZh"]', { timeout: 8000 });
      /* 清空后逐字输入，等同真人操作：一次性赋值会被表单的重渲染覆盖掉 */
      for (const [k, v] of [["companyNameZh", zh], ["companyNameEn", en], ["boothNo", booth]]) {
        const sel = `#editForm input[data-k="${k}"]`;
        await A.page.evaluate((s) => { document.querySelector(s).value = ""; }, sel);
        await A.page.type(sel, v);
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    await A.page.evaluate(() => go("home"));
    await new Promise((r) => setTimeout(r, 200));
    const aCount = await A.page.evaluate(() => FR.suppliers.length);
    check(aCount === 2, `A 录入 2 家（实际 ${aCount}）`);

    await A.page.evaluate(async () => {
      const sid = FR.suppliers[0].id;
      const c = document.createElement("canvas"); c.width = 600; c.height = 450;
      const g = c.getContext("2d");
      g.fillStyle = "#0a5"; g.fillRect(0, 0, 600, 450);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
      await addPhoto(sid, new File([blob], "md.jpg", { type: "image/jpeg" }), "product");
      await FR.refresh();
    });

    await configure(A.page, TOKEN);
    const pushed = await A.page.evaluate(async () => await window.FRSync.push("full"));
    check(pushed.photos >= 1, `A 已备份含照片（${pushed.photos} 张，commit ${pushed.sha}）`);

    /* ---------- 设备 B：全新设备，拉取云端全部展会 ---------- */
    const B = await newDevice(browser, "B");
    const bFairs0 = await B.page.evaluate(() => (FR.fairs || []).length);
    check(bFairs0 === 0, `B 是一台空设备（展会数 ${bFairs0}）`);

    await configure(B.page, TOKEN);
    const remote = await B.page.evaluate(async () => await window.FRSync.listRemoteFairs());
    const hit = remote.find((f) => f.id === fairId);
    check(!!hit, `B 能在云端看到 A 建的展会（云端 ${remote.length} 个）`);
    check(hit && hit.suppliers === 2, `云端展会记录数一致（${hit ? hit.suppliers : "?"}）`);

    const pulled = await B.page.evaluate(async (withPhotos) => {
      return await window.FRSync.pullAll({ photos: withPhotos });
    }, true);
    const pr = pulled.find((r) => r.id === fairId) || {};
    check(!pr.error, `B 拉取成功（${pr.error || "无错误"}）`);
    check(pr.suppliers === 2, `B 拉到 2 条记录（实际 ${pr.suppliers}）`);
    check(pr.photos === 1, `B 拉到 1 张照片（实际 ${pr.photos}）`);

    const bState = await B.page.evaluate(async () => {
      await FR.refresh();
      const all = await FR.all("fairs");
      return { fairs: all.length, hasFair: all.some((f) => f.id === window.__fid),
               suppliers: (await FR.all("suppliers")).length,
               photos: (await FR.all("photos")).length,
               weights: FR.settings.weights };
    }).catch(async () => await B.page.evaluate(async () => {
      await FR.refresh();
      return { fairs: (await FR.all("fairs")).length,
               suppliers: (await FR.all("suppliers")).length,
               photos: (await FR.all("photos")).length,
               weights: FR.settings.weights };
    }));
    check(bState.fairs >= 1, `B 本地已出现该展会（${bState.fairs} 个）`);
    check(bState.photos === 1, `B 照片已落到本地（${bState.photos} 张）`);
    check(bState.weights && bState.weights.fit === 30,
      `权重随同步传播（B 的 fit = ${bState.weights && bState.weights.fit}）`);

    /* ---------- B 改一条记录并备份，A 双向同步后应看到 ---------- */
    const changed = await B.page.evaluate(async (fid) => {
      await FR.selectFair(fid);
      await FR.refresh();
      const s = FR.suppliers[0];
      const before = s.companyNameEn;
      const rec = Object.assign({}, s, {
        companyNameEn: "Factory Alpha (edited on B)",
        updatedAt: new Date().toISOString(),
      });
      await FR.put("suppliers", rec);
      await FR.refresh();
      return { before, after: rec.companyNameEn };
    }, fairId);
    const bPush = await B.page.evaluate(async () => await window.FRSync.push("meta"));
    check(bPush.chunks >= 1, `B 的改动已上传（脏块 ${bPush.chunks}）`);

    const aSync = await A.page.evaluate(async (fid) => {
      await FR.selectFair(fid);
      await FR.refresh();
      return await window.FRSync.syncNow("meta");
    }, fairId);
    const aNow = await A.page.evaluate(async () => {
      await FR.refresh();
      return (FR.suppliers.find((s) => /Factory Alpha/.test(s.companyNameEn || "")) || {}).companyNameEn;
    });
    check(/edited on B/.test(aNow || ""), `A 双向同步后拿到了 B 的改动（${aNow}）`);
    check(aSync && aSync.pushed && aSync.pushed.files >= 1, "A 同步时也完成了上传");

    /* ---------- 反向：A 改，B 拉 ---------- */
    const aList = await A.page.evaluate(async (fid) => {
      await FR.selectFair(fid);
      await FR.refresh();
      return FR.suppliers.map((s) => ({
        zh: s.companyNameZh, en: s.companyNameEn, booth: s.boothNo, id: String(s.id).slice(0, 6),
      }));
    }, fairId);
    console.log("  [debug] A 当前展会记录：" + JSON.stringify(aList));
    await A.page.evaluate(async () => {
      await FR.refresh();
      const s = FR.suppliers.find((x) => /Factory Beta/.test(x.companyNameEn || ""));
      if (!s) throw new Error("A 端找不到 Factory Beta，现有：" + FR.suppliers.length + " 条");
      await FR.put("suppliers", Object.assign({}, s, {
        companyNameEn: "Factory Beta (edited on A)", updatedAt: new Date().toISOString(),
      }));
      await FR.refresh();
    });
    await A.page.evaluate(async () => await window.FRSync.push("meta"));
    const bPull2 = await B.page.evaluate(async (fid) => await window.FRSync.pullFair(fid, { photos: false }), fairId);
    const bNow = await B.page.evaluate(async () => {
      await FR.refresh();
      return (FR.suppliers.find((s) => /Factory Beta/.test(s.companyNameEn || "")) || {}).companyNameEn;
    });
    check(/edited on A/.test(bNow || ""), `B 拉取后拿到了 A 的改动（${bNow}）`);

    console.log("");
    console.log("FAIR_ID=" + fairId);

    const errs = [...A.errors, ...B.errors];
    if (errs.length) {
      console.log("页面错误：");
      errs.slice(0, 8).forEach((e) => console.log("   " + e));
      process.exitCode = 1;
    } else {
      console.log("无 JS 运行时错误");
    }
  } catch (e) {
    console.error("multi-device e2e failed:", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
