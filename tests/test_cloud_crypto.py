"""Cross-language check: encrypt in the browser (app/sync.js), decrypt in Python.

The cloud copy can optionally be encrypted with AES-GCM + PBKDF2-SHA256/100k.
If the two sides ever drift, a backup becomes unreadable — which is exactly the
failure we cannot afford. So this test drives the *real* app code in Chromium,
writes the ciphertext to disk, and decrypts it with scripts/pull_cloud.py.

Run after starting the local preview server (see tests/smoke_app.js).
"""
from __future__ import annotations

import base64
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

PASS = "展会-2026-Secret!"          # non-ASCII on purpose: TextEncoder must match


def js_encrypt(url: str, out_dir: Path) -> dict:
    """Drive the app's own crypto functions in a real browser."""
    script = r"""
(async () => {
  const puppeteer = require('puppeteer');
  const fs = require('fs');
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.goto(process.argv[2], { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 800));
  const out = await p.evaluate(async (pass) => {
    const C = window.FRSync._crypto;
    const salt = C.newSaltB64();
    const key = await C.deriveKey(pass, salt);
    const payload = { hello: "供应商数据", n: 42, nested: { a: [1, 2, 3] } };
    const enc = await C.encJSON(payload, key);
    // a tiny binary blob too (photos take this path)
    const raw = new Uint8Array([1, 2, 3, 250, 0, 128]);
    const blob = await C.encBlob(new Blob([raw]), key);
    const buf = new Uint8Array(await blob.arrayBuffer());
    return { salt, enc, blobB64: btoa(String.fromCharCode.apply(null, buf)),
             params: C.ENC };
  }, process.argv[3]);
  fs.writeFileSync(process.argv[4], JSON.stringify(out));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
"""
    js = out_dir / "_enc.js"
    js.write_text(script, encoding="utf-8")
    target = out_dir / "_enc.json"
    env = {"NODE_PATH": r"C:/Users/Leo/.workbuddy/binaries/node/workspace/node_modules",
           "PATH": str(Path(r"C:/Users/Leo/.workbuddy/binaries/node/versions/22.22.2-6").parent)}
    import os
    full_env = dict(os.environ)
    full_env.update(env)
    subprocess.run(
        [str(Path(r"C:/Users/Leo/.workbuddy/binaries/node/versions/22.22.2-6/node.exe")),
         str(js), url, PASS, str(target)],
        check=True, env=full_env, cwd=str(ROOT))
    return json.loads(target.read_text(encoding="utf-8"))


def main() -> int:
    import pull_cloud

    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/index.html"
    ok = True
    with tempfile.TemporaryDirectory() as td:
        data = js_encrypt(url, Path(td))
        key = pull_cloud.derive_key(PASS, base64.b64decode(data["salt"]),
                                    int(data["params"]["iterations"]))

        got = pull_cloud.dec_json(data["enc"], key)
        want = {"hello": "供应商数据", "n": 42, "nested": {"a": [1, 2, 3]}}
        if got != want:
            print("FAIL json round-trip:", got)
            ok = False
        else:
            print("ok  JS→Python JSON 解密一致（含中文）")

        raw = base64.b64decode(data["blobB64"])
        pt = pull_cloud.dec_bytes(raw, key)
        if list(pt) != [1, 2, 3, 250, 0, 128]:
            print("FAIL blob round-trip:", list(pt))
            ok = False
        else:
            print("ok  JS→Python Blob 解密一致（照片路径）")

        # wrong passphrase must fail loudly, not silently return garbage
        try:
            pull_cloud.dec_json(data["enc"],
                                pull_cloud.derive_key("wrong", base64.b64decode(data["salt"]),
                                                      int(data["params"]["iterations"])))
            print("FAIL wrong passphrase did not raise")
            ok = False
        except Exception:
            print("ok  错误口令被拒绝（不会静默产出垃圾数据）")

    print("PASS" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
