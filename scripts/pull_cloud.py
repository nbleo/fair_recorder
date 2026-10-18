"""Pull a person's fair data from the PRIVATE GitHub repo into inbox/.

The phone app writes to  <root>/<user>/fairs/<fairId>/{meta.json,suppliers-*.json,assets/*.jpg}
(see app/sync.js).  This script downloads one namespace (or one fair inside it) and
repacks it as a ZIP that looks exactly like a phone export, so the normal pipeline
(`build_report.py`) can consume it without any change.

Typical use after the fair:

    GITHUB_TOKEN=... python scripts/pull_cloud.py --user leo --all-fairs
    python scripts/build_report.py --inbox inbox --output output --top 5

Security notes
--------------
* The token is read from the environment (or --token-stdin) and never written to disk.
* The script refuses to pull from a PUBLIC repository, and refuses the known public
  code repo, so company/supplier data can never be mistaken for source code.
* If the cloud copy is encrypted (AES-GCM + PBKDF2-SHA256/100k), pass --passphrase;
  the parameters are read from meta.json, matching app/sync.js exactly.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

API = "https://api.github.com"

# Public repo that only ever holds program code + Pages. Never read data from it.
PUBLIC_CODE_REPOS = {("nbleo", "fair_recorder")}

SCHEMA_VERSION = 2


class Fail(Exception):
    pass


def api(path: str, token: str, method: str = "GET", body: dict | None = None,
        retries: int = 2) -> tuple[int, object]:
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "FairRecorder-pull")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    if data:
        req.add_header("Content-Type", "application/json")
    last = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, data, timeout=60) as r:
                raw = r.read().decode("utf-8", "replace")
                return r.status, (json.loads(raw) if raw.strip() else {})
        except urllib.error.HTTPError as e:
            body_txt = e.read().decode("utf-8", "replace")[:400]
            last = RuntimeError(f"{e.code} {e.reason} — {body_txt}")
            if e.code in (403, 429) and attempt < retries:      # rate limit
                time.sleep(2 + 2 * attempt)
                continue
            return e.code, body_txt
        except Exception as e:                                   # network
            last = e
            if attempt < retries:
                time.sleep(2 + 2 * attempt)
                continue
    raise Fail(f"request failed: {last}")


def repo_info(owner: str, repo: str, token: str) -> dict:
    st, r = api(f"/repos/{owner}/{repo}", token)
    if st != 200 or not isinstance(r, dict):
        raise Fail(f"cannot read {owner}/{repo}: {st} {r}")
    return r


def tree_of(owner: str, repo: str, branch: str, token: str) -> list[dict]:
    st, r = api(f"/repos/{owner}/{repo}/git/trees/{branch}?recursive=1", token)
    if st != 200 or not isinstance(r, dict) or r.get("truncated"):
        raise Fail(f"cannot read tree of {branch}: {st}")
    return r.get("tree", [])


def blob(owner: str, repo: str, sha: str, token: str) -> bytes:
    st, r = api(f"/repos/{owner}/{repo}/git/blobs/{sha}", token)
    if st != 200 or not isinstance(r, dict):
        raise Fail(f"cannot read blob {sha[:8]}: {st}")
    enc = r.get("encoding")
    content = r.get("content") or ""
    if enc == "base64":
        return base64.b64decode(content)
    return content.encode("utf-8")


# --------------------------------------------------------------------- crypto
def derive_key(passphrase: str, salt: bytes, iterations: int = 100000) -> bytes:
    import hashlib
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, iterations)


def dec_json(payload: dict, key: bytes) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = base64.b64decode(payload["iv"])
    ct = base64.b64decode(payload["ct"])
    # associated_data=None matches Web Crypto's AES-GCM with no additionalData
    return json.loads(AESGCM(key).decrypt(iv, ct, None).decode("utf-8"))


def dec_bytes(raw: bytes, key: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM(key).decrypt(raw[:12], raw[12:], None)


# ----------------------------------------------------------------------- pull
def parse_meta(raw: bytes) -> dict:
    return json.loads(raw.decode("utf-8", "replace"))


def build_zip(suppliers: list[dict], plans: list[dict], photos: list[dict],
              photo_bytes: dict[str, bytes], fair: dict, exported_at: str,
              weights: dict | None = None) -> bytes:
    """Repack into the exact shape the phone exports (see app/index.html buildBundle)."""
    bundle = {
        "schemaVersion": SCHEMA_VERSION,
        "fair": fair,
        "export": {
            "id": "cloud-pull",
            "deviceId": "pull_cloud.py",
            "createdAt": exported_at,
            "mode": "full",
            "appVersion": "cloud",
            "counts": {"suppliers": len(suppliers), "photos": len(photos),
                       "plans": len(plans), "tombstones": 0},
            "weights": weights or {},
            "event": {},
            "source": "github-private-repo",
        },
        "suppliers": suppliers,
        "visitPlans": plans,
        "photos": photos,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("suppliers.json", json.dumps(bundle, ensure_ascii=False))
        for p in photos:
            data = photo_bytes.get(p["id"])
            if data is not None:
                z.writestr(p["path"], data, compress_type=zipfile.ZIP_STORED)
    return buf.getvalue()


def pull_fair(owner: str, repo: str, branch: str, token: str, root: str, user: str,
              fair_id: str, tree: list[dict], passphrase: str | None) -> tuple[str, bytes]:
    base = f"{root}/{user}/fairs/{fair_id}"
    idx = {t["path"]: t for t in tree if t.get("type") == "blob"}
    meta_entry = idx.get(f"{base}/meta.json")
    if not meta_entry:
        raise Fail(f"no backup at {base}/meta.json")

    meta = parse_meta(blob(owner, repo, meta_entry["sha"], token))
    if meta.get("layout") == "per-fair/v1":                      # legacy single-file
        raise Fail(f"{base} uses the legacy layout; pull it from the phone export instead")

    key = None
    if meta.get("encrypted"):
        if not passphrase:
            raise Fail(f"{base} is encrypted — pass --passphrase (the same one used in the app)")
        enc = meta.get("enc") or {}
        if not enc.get("salt"):
            raise Fail("cloud meta has no salt, cannot decrypt")
        key = derive_key(passphrase, base64.b64decode(enc["salt"]),
                         int(enc.get("iterations", 100000)))

    suppliers: list[dict] = []
    for c in meta.get("chunks", []):
        e = idx.get(c["path"])
        if not e:
            print(f"  ! missing chunk {c['path']}", file=sys.stderr)
            continue
        parsed = parse_meta(blob(owner, repo, e["sha"], token))
        payload = dec_json(parsed, key) if (key and parsed.get("enc") == 1) else parsed
        suppliers.extend(payload.get("items", []))

    photos: list[dict] = []
    photo_bytes: dict[str, bytes] = {}
    for path, e in idx.items():
        if not path.startswith(f"{base}/assets/"):
            continue
        pid = path.rsplit("/", 1)[-1]
        if not pid.endswith(".jpg"):
            continue
        pid = pid[:-4]
        raw = blob(owner, repo, e["sha"], token)
        data = dec_bytes(raw, key) if key else raw
        photos.append({"id": pid, "supplierId": None, "type": "product",
                       "path": f"photos/{pid}.jpg", "size": len(data),
                       "sha256": "", "createdAt": meta.get("updatedAt", "")})
        photo_bytes[pid] = data

    fair = meta.get("fair") or {}
    fair.setdefault("id", fair_id)
    zipped = build_zip(suppliers, [], photos, photo_bytes, fair,
                       meta.get("updatedAt") or "", meta.get("weights"))
    return fair_id, zipped


def main(argv: list[str] | None = None) -> int:
    here = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description="Pull fair data from the private GitHub repo")
    ap.add_argument("--owner", default=os.environ.get("FR_OWNER", ""))
    ap.add_argument("--repo", default=os.environ.get("FR_REPO", "fairrecorder-data"))
    ap.add_argument("--branch", default=os.environ.get("FR_BRANCH", "main"))
    ap.add_argument("--root", default=os.environ.get("FR_ROOT", "users"))
    ap.add_argument("--user", help="namespace to pull, e.g. leo (omit to list)")
    ap.add_argument("--fair", help="only this fair id (default: all fairs of the user)")
    ap.add_argument("--all-fairs", action="store_true", help="pull every fair of the user")
    ap.add_argument("--out", default=str(here / "inbox"))
    ap.add_argument("--passphrase", default=None)
    ap.add_argument("--token", default=None,
                    help="GitHub token; defaults to $GITHUB_TOKEN")
    ap.add_argument("--list", action="store_true", help="list users/fairs then exit")
    args = ap.parse_args(argv)

    token = args.token or os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("error: set GITHUB_TOKEN or pass --token", file=sys.stderr)
        return 2
    if not args.owner:
        print("error: --owner is required (or set FR_OWNER)", file=sys.stderr)
        return 2

    if (args.owner.lower(), args.repo.lower()) in PUBLIC_CODE_REPOS:
        print(f"error: {args.owner}/{args.repo} is the PUBLIC code repo — "
              "supplier data must never be read from it.", file=sys.stderr)
        return 2

    info = repo_info(args.owner, args.repo, token)
    if not info.get("private"):
        print(f"error: {info.get('full_name')} is PUBLIC. Data must live in a private repo.",
              file=sys.stderr)
        return 2
    print(f"repo   : {info['full_name']} (private)")

    tree = tree_of(args.owner, args.repo, args.branch, token)
    base = args.root.strip("/")
    namespaces = sorted({p.split("/")[1] for p, t in
                         ((t["path"], t) for t in tree if t.get("type") == "blob")
                         if p.startswith(base + "/") and len(p.split("/")) > 3})

    if args.list or not args.user:
        print("users  :", ", ".join(namespaces) or "(none)")
        for u in namespaces:
            fids = sorted({p.split("/")[3] for p in
                           (t["path"] for t in tree if t.get("type") == "blob")
                           if p.startswith(f"{base}/{u}/fairs/") and len(p.split("/")) > 4})
            print(f"  {u}: {', '.join(fids) or '(no fair)'}")
        if not args.user:
            return 0

    if args.user not in namespaces:
        print(f"error: namespace '{args.user}' not found. Available: {namespaces}",
              file=sys.stderr)
        return 2

    fids = sorted({p.split("/")[3] for p in
                   (t["path"] for t in tree if t.get("type") == "blob")
                   if p.startswith(f"{base}/{args.user}/fairs/") and len(p.split("/")) > 4})
    if args.fair:
        fids = [f for f in fids if args.fair in f]

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    written = []
    for fid in fids:
        try:
            fid, data = pull_fair(args.owner, args.repo, args.branch, token, base,
                                  args.user, fid, tree, args.passphrase)
        except Fail as e:
            print(f"  ! {fid}: {e}", file=sys.stderr)
            continue
        p = out / f"cloud-{args.user}-{fid[:8]}-{ts}.zip"
        p.write_bytes(data)
        written.append(p)
        print(f"  ✓ {p.name}  ({len(data) / 1024:.0f} KB)")

    print(f"pulled {len(written)} fair(s) into {out}")
    print("next   : python scripts/build_report.py --inbox inbox --output output --top 5")
    return 0 if written else 1


if __name__ == "__main__":
    raise SystemExit(main())
