"""用真实样本数据在真浏览器里跑一遍手机端报告生成，产物落到 output/mobile-sample/。

    需要先生成样本：python scripts/make_sample.py
    运行：python scripts/gen_mobile_sample.py

这是给"界面里导出报告"这条链路做的成品演示——和手机上点按钮走的是同一段代码。
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE = r"C:/Users/Leo/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
NODE_PATH = r"C:/Users/Leo/.workbuddy/binaries/node/workspace/node_modules"
OUT = ROOT / "output" / "mobile-sample"

JS = r"""
const puppeteer = require("puppeteer");
const http = require("http"); const fs = require("fs"); const path = require("path");
const ROOT = process.argv[2];
const APP = path.join(ROOT, "app");
const OUT = process.argv[3];
const ZIPS = process.argv.slice(4);
const PORT = 8950 + Math.floor(Math.random() * 40);
const MIME = {".html":"text/html",".js":"text/javascript",".png":"image/png",
  ".webmanifest":"application/manifest+json"};
const srv = http.createServer((q, r) => {
  const rel = decodeURIComponent(q.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const f = path.join(APP, rel);
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, {"Content-Type": MIME[path.extname(f)] || "application/octet-stream"});
  fs.createReadStream(f).pipe(r);
});
srv.listen(PORT, "127.0.0.1", async () => {
  const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle2" });
  await p.waitForFunction(() => window.FR && window.FRReport, { timeout: 20000 });

  for (const z of ZIPS) {
    const input = await p.$("#fileImport");
    await input.uploadFile(z);
    await new Promise((r) => setTimeout(r, 2500));
  }
  await p.evaluate(() => go("home"));
  await new Promise((r) => setTimeout(r, 800));

  const dump = async (label, opts, fname) => {
    const ctx = await p.evaluate(async (o) => {
      const c = await FRReport.buildContext(o);
      return { html: FRReport.renderHTML(c), n: c.suppliers.length,
               picks: c.picks.length, fair: c.event.name };
    }, opts);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, fname), ctx.html, "utf8");
    console.log(`${label}: ${ctx.n} suppliers / ${ctx.picks} picks -> ${fname} (${ctx.fair})`);
    return ctx;
  };

  await dump("current fair", { topN: 5, withPhotos: true,
    preparedFor: "Schulte – Shower enclosure sourcing" }, "Supplier_Report_EN.html");
  await dump("all fairs", { all: true, topN: 5, withPhotos: true,
    preparedFor: "Schulte – Shower enclosure sourcing" }, "Supplier_Report_All_Fairs.html");

  const x = await p.evaluate(async () => {
    const c = await FRReport.buildContext({ topN: 5, withPhotos: false });
    const blob = await FRReport.toXLSX(c);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return { b64: btoa(s), csv: FRReport.toCSV(c, "master") };
  });
  fs.writeFileSync(path.join(OUT, "Supplier_Master.xlsx"), Buffer.from(x.b64, "base64"));
  fs.writeFileSync(path.join(OUT, "Supplier_Master.csv"), x.csv, "utf8");
  console.log("xlsx + csv written");
  await b.close(); srv.close();
});
"""


def main() -> int:
    sample = sorted((ROOT / "sample").glob("*.zip"))
    if not sample:
        print("no sample zips — run: python scripts/make_sample.py")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = ROOT / ".tmp_gen_sample.js"
    tmp.write_text(JS, encoding="utf-8")
    cmd = [NODE, str(tmp), str(ROOT), str(OUT)] + [str(z) for z in sample]
    env = {"NODE_PATH": NODE_PATH, "PATH": ""}
    import os
    full = dict(os.environ); full.update(env)
    r = subprocess.run(cmd, env=full, capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip()[-800:])
    tmp.unlink(missing_ok=True)
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
