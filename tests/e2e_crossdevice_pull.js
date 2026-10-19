const puppeteer = require("puppeteer");
const http = require("http");
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "app");
const PORT = Number(process.env.PORT || 8953);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".webmanifest": "application/json" };
const TOKEN = process.env.GH_TOKEN;
let pass = 0, fail = 0;
const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); ok ? pass++ : fail++; };

const srv = http.createServer((q, r) => {
  const rel = q.url.split("?")[0].replace(/^\/+/, "") || "index.html";
  const f = path.join(APP, rel);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(r);
});

srv.listen(PORT, "127.0.0.1", async () => {
  const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("dialog", async (d) => { await d.accept(); });
  await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle2" });
  await p.waitForFunction(() => window.FR && FR.settings && !!FR.settings.deviceId, { timeout: 20000 });

  console.log("\n=== 场景：手机是全新设备，电脑端已在云端上传过展会 ===");

  /* 1) 配置并保存 */
  await p.evaluate(() => go("sync"));
  await new Promise((r) => setTimeout(r, 600));
  await p.evaluate((tk) => {
    document.getElementById("syOwner").value = "nbleo";
    document.getElementById("syRepo").value = "fairrecorder-data";
    document.getElementById("syToken").value = tk;
    document.getElementById("syBranch").value = "main";
    document.getElementById("syRoot").value = "users";
  }, TOKEN);
  await p.evaluate(() => document.getElementById("sySave").click());
  await p.waitForFunction(
    () => /连接成功|校验未通过/.test(document.getElementById("syLog").textContent),
    { timeout: 40000 });

  const saveLog = await p.$eval("#syLog", (el) => el.textContent.replace(/\s+/g, " ").trim());
  console.log("  [保存后日志]", saveLog.slice(0, 220));
  await new Promise((r) => setTimeout(r, 2500));
  const who = await p.$eval("#syWho", (el) => el.textContent.trim());
  check(/nbleo/.test(who) && /users\/nbleo/.test(who), "状态区显示命名空间完整路径：" + who);

  /* 2) 保存后应自动列出云端展会 */
  await new Promise((r) => setTimeout(r, 3000));
  const rl = await p.$eval("#syRemoteList", (el) => ({
    hidden: el.classList.contains("hide"),
    text: el.textContent.replace(/\s+/g, " ").trim(),
  }));
  check(!rl.hidden, "保存后云端展会清单自动展开");
  check(/云端展会（\d+）/.test(rl.text) && /广交会/.test(rl.text), "清单里能看到电脑端上传的展会：" + rl.text.slice(0, 70));

  /* 3) 手机端自建一个展会（ID 必然与电脑端不同），再点「从云端恢复本展会」 */
  await p.evaluate(async () => {
    const id = FR.uid();
    await FR.put("fairs", { id, name: "手机自建展会", nameEn: "Phone Local Fair",
      city: "", venue: "Phone", area: "", phase: "",
      startDate: "2026-10-23", endDate: "2026-10-27", defaultHall: "A区", notes: "",
      archived: false, lastPushAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null });
    await FR.selectFair(id);
    go("sync");
  });
  await new Promise((r) => setTimeout(r, 600));
  await p.evaluate(() => document.getElementById("syPull").click());
  await p.waitForFunction(
    () => /拉取失败|拉取完成|拉取已取消/.test(document.getElementById("syLog").textContent),
    { timeout: 40000 });
  const log1 = await p.$eval("#syLog", (el) => el.textContent.replace(/\s+/g, " "));
  console.log("  [点错按钮的提示]", log1.slice(0, 200));
  check(/云端现有 \d+ 个展会/.test(log1), "点错按钮时给出可操作指引（列出云端展会）");
  check(/拉取云端全部展会/.test(log1), "指引里点名了正确的按钮");

  /* 4) 点「拉取云端全部展会」 */
  await p.evaluate(() => { document.getElementById("syLog").innerHTML = ""; });
  await p.evaluate(() => document.getElementById("syPullAll").click());
  await p.waitForFunction(
    () => /全部拉取完成|拉取失败/.test(document.getElementById("syLog").textContent),
    { timeout: 60000 });
  const log2 = await p.$eval("#syLog", (el) => el.textContent.replace(/\s+/g, " "));
  console.log("  log:", log2.slice(0, 160));
  check(/全部拉取完成/.test(log2), "「拉取云端全部展会」成功");

  const local = await p.evaluate(async () => {
    await FR.refresh();
    const cf = (FR.fairs || []).find((f) => /广交会/.test(f.name || ""));
    await FR.selectFair(cf.id);
    await FR.refresh();
    return { fairs: (FR.fairs || []).length,
      names: (FR.fairs || []).map((f) => f.name),
      suppliers: FR.suppliers.map((s) => s.companyNameEn || s.companyNameZh || s.id) };
  });
  check(/广交会/.test(local.names.join("、")), "电脑端的展会已出现在本机：" + local.names.join("、"));
  check(local.suppliers.length > 0, "记录已拉到：" + local.suppliers.join("、"));

  console.log("\nPASS=" + pass + "  FAIL=" + fail);
  console.log("JS errors:", errs.length ? errs.slice(0, 3) : "none");
  await b.close();
  srv.close();
});
