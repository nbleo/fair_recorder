"""Delete fairs (or a whole namespace) from the PRIVATE GitHub data repo.

Only ever needed to clean up test uploads or a fair that was synced by mistake.
The private repo keeps history, so a purge is recoverable — but the app will no
longer see the fair.

    # what would go?
    GITHUB_TOKEN=... python scripts/purge_cloud.py --user nbleo --starts-with E2E

    # really delete it
    GITHUB_TOKEN=... python scripts/purge_cloud.py --user nbleo --starts-with E2E --yes

    # one exact fair
    GITHUB_TOKEN=... python scripts/purge_cloud.py --user nbleo --fair <fair-id> --yes

Refuses to touch anything outside <root>/<user>/fairs/ and refuses public repos.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"
PUBLIC_CODE_REPOS = {("nbleo", "fair_recorder")}


def api(method: str, path: str, token: str, body: dict | None = None) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw[:300]
    except Exception as e:
        return -1, str(e)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--owner", default="nbleo")
    ap.add_argument("--repo", default="fairrecorder-data")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--root", default="users")
    ap.add_argument("--user", required=True)
    ap.add_argument("--fair", help="exact fair id")
    ap.add_argument("--starts-with", help="delete every fair whose meta name starts with this")
    ap.add_argument("--yes", action="store_true", help="actually delete (default is a dry run)")
    args = ap.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        raise SystemExit("set GITHUB_TOKEN")

    s, repo = api("GET", f"/repos/{args.owner}/{args.repo}", token)
    if s != 200:
        raise SystemExit(f"cannot read repo: HTTP {s} {repo}")
    if not repo.get("private"):
        raise SystemExit(f"{args.owner}/{args.repo} is PUBLIC — refusing to touch it")
    if (args.owner.lower(), args.repo.lower()) in PUBLIC_CODE_REPOS:
        raise SystemExit("that is the public code repo")

    base = f"{args.root}/{args.user}/fairs"
    s, ref = api("GET", f"/repos/{args.owner}/{args.repo}/git/ref/heads/{args.branch}", token)
    if s != 200:
        raise SystemExit(f"cannot read branch: HTTP {s}")
    s, tr = api("GET", f"/repos/{args.owner}/{args.repo}/git/trees/{args.branch}?recursive=1", token)
    if s != 200:
        raise SystemExit(f"cannot read tree: HTTP {s}")
    blobs = [t for t in tr.get("tree", []) if t.get("type") == "blob" and t["path"].startswith(base + "/")]

    # fair id -> display name
    names: dict[str, str] = {}
    for t in blobs:
        if not t["path"].endswith("/meta.json"):
            continue
        fid = t["path"][len(base) + 1:].split("/")[0]
        s2, b = api("GET", f"/repos/{args.owner}/{args.repo}/git/blobs/{t['sha']}", token)
        if s2 == 200 and b.get("content"):
            import base64
            try:
                meta = json.loads(base64.b64decode(b["content"]))
                f = meta.get("fair") or {}
                names[fid] = (f.get("name") or "", f.get("nameEn") or "")
            except Exception:
                pass

    victims = set()
    if args.fair:
        victims.add(args.fair)
    elif args.starts_with:
        for fid, nm in names.items():          # nm = (中文名, 英文名)，任一匹配即可
            if any(x.startswith(args.starts_with) for x in nm if x):
                victims.add(fid)
    else:
        raise SystemExit("give --fair or --starts-with")

    doomed = [t for t in blobs if t["path"][len(base) + 1:].split("/")[0] in victims]
    if not doomed:
        print("nothing to delete")
        return 0

    print(f"{'DELETE' if args.yes else 'would delete'} {len(doomed)} file(s) "
          f"under {len(victims)} fair(s) in {args.owner}/{args.repo}:")
    for v in sorted(victims):
        print(f"  - {v}  {names.get(v, ('',))[0]}")
    if not args.yes:
        print("\ndry run — add --yes to delete")
        return 0

    tree = [{"path": t["path"], "mode": "100644", "type": "blob", "sha": None} for t in doomed]
    for attempt in range(4):
        s, ref = api("GET", f"/repos/{args.owner}/{args.repo}/git/ref/heads/{args.branch}", token)
        parent = ref["object"]["sha"]
        s, c = api("GET", f"/repos/{args.owner}/{args.repo}/git/commits/{parent}", token)
        s, t2 = api("POST", f"/repos/{args.owner}/{args.repo}/git/trees", token,
                    {"base_tree": c["tree"]["sha"], "tree": tree})
        if s not in (200, 201):
            raise SystemExit(f"tree failed: {s} {t2}")
        s, cm = api("POST", f"/repos/{args.owner}/{args.repo}/git/commits", token,
                    {"message": f"purge {len(victims)} fair(s) from {args.user}",
                     "tree": t2["sha"], "parents": [parent]})
        s, _ = api("PATCH", f"/repos/{args.owner}/{args.repo}/git/refs/heads/{args.branch}", token,
                   {"sha": cm["sha"]})
        if s == 200:
            print(f"purged — commit {cm['sha'][:7]}")
            return 0
        if s != 422:
            raise SystemExit(f"update ref failed: {s} {cm}")
        time.sleep(0.5 * (attempt + 1))
    raise SystemExit("could not update the branch (concurrent writes)")


if __name__ == "__main__":
    raise SystemExit(main())
