#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Push the local repository to GitHub **without** the git protocol.

Why this exists: in some corporate / sandboxed networks the plain
git-over-HTTPS endpoint (github.com:443) is blocked by the proxy while
api.github.com is reachable.  This script speaks the GitHub *Git Data API*
(blobs -> tree -> commit -> update-ref) instead, so it works through the
same egress path as every other REST call.

Only files tracked by git (`git ls-files`) are uploaded, so anything in
.gitignore (config.json, output/, inbox/) never leaves the machine.

Usage:
    GITHUB_TOKEN=<pat> python scripts/push_via_api.py
    GITHUB_TOKEN=<pat> python scripts/push_via_api.py --repo nbleo/fair_recorder
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.github.com"
ROOT = Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------- http
def _req(method: str, path: str, token: str, payload: dict | None = None):
    url = API + path if path.startswith("/") else path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "FairRecorder-push/1.0")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode("utf-8")
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:600]
    except Exception as e:                                    # noqa: BLE001
        return 0, str(e)


def api(method: str, path: str, token: str, payload: dict | None = None, tries: int = 4):
    """Call the API, retrying on transient 5xx / network errors."""
    for attempt in range(tries):
        status, body = _req(method, path, token, payload)
        if status in (500, 502, 503, 504) or status == 0:
            wait = 2 * (attempt + 1)
            print(f"    retry {attempt + 1}/{tries} after {wait}s (status={status})")
            time.sleep(wait)
            continue
        return status, body
    return status, body


# --------------------------------------------------------------------------- local
def tracked_files() -> list[str]:
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True,
                         check=True)
    return [ln.strip() for ln in out.stdout.splitlines() if ln.strip()]


def read_bytes(rel: str) -> bytes:
    return (ROOT / rel).read_bytes()


# --------------------------------------------------------------------------- push
def push(repo: str, branch: str, message: str, token: str, dry: bool = False) -> int:
    owner, name = repo.split("/", 1)

    files = tracked_files()
    print(f"tracked files: {len(files)}")
    if dry:
        for f in files:
            print("   ", f)
        return 0

    # --- current head (may not exist yet on an empty repo) -------------------
    status, ref = api("GET", f"/repos/{owner}/{name}/git/ref/heads/{branch}", token)
    if status == 200:
        head_sha = ref["object"]["sha"]
        _, head_commit = api("GET", f"/repos/{owner}/{name}/git/commits/{head_sha}", token)
        base_tree = head_commit.get("tree", {}).get("sha")
        parents = [head_sha]
        print(f"head: {head_sha[:8]}  base_tree: {(base_tree or '-')[:8]}")
    elif status in (404, 409):
        head_sha, base_tree, parents = None, None, []
        print("head: (empty repository — first commit)")
    else:
        print(f"cannot read ref: {status} {ref}", file=sys.stderr)
        return 1

    # --- blobs ---------------------------------------------------------------
    tree = []
    for i, rel in enumerate(files, 1):
        raw = read_bytes(rel)
        payload = {"content": base64.b64encode(raw).decode("ascii"),
                   "encoding": "base64"}
        st, body = api("POST", f"/repos/{owner}/{name}/git/blobs", token, payload)
        if st not in (200, 201):
            print(f"  blob FAIL {rel}: {st} {body}", file=sys.stderr)
            return 1
        tree.append({"path": rel.replace("\\", "/"), "mode": "100644",
                     "type": "blob", "sha": body["sha"]})
        if i % 10 == 0 or i == len(files):
            print(f"  blobs {i}/{len(files)}")
        if i % 40 == 0:                       # be gentle with secondary rate limits
            time.sleep(1)

    # --- tree ----------------------------------------------------------------
    payload = {"tree": tree}
    if base_tree:
        payload["base_tree"] = base_tree
    st, body = api("POST", f"/repos/{owner}/{name}/git/trees", token, payload)
    if st not in (200, 201):
        print(f"  tree FAIL: {st} {body}", file=sys.stderr)
        return 1
    tree_sha = body["sha"]
    print(f"tree: {tree_sha[:8]} ({len(tree)} entries)")

    # --- commit --------------------------------------------------------------
    st, body = api("POST", f"/repos/{owner}/{name}/git/commits", token,
                   {"message": message, "tree": tree_sha, "parents": parents})
    if st not in (200, 201):
        print(f"  commit FAIL: {st} {body}", file=sys.stderr)
        return 1
    commit_sha = body["sha"]
    print(f"commit: {commit_sha[:8]}")

    # --- update ref ----------------------------------------------------------
    if head_sha is None:
        st, body = api("POST", f"/repos/{owner}/{name}/git/refs", token,
                       {"ref": f"refs/heads/{branch}", "sha": commit_sha})
    else:
        st, body = api("PATCH", f"/repos/{owner}/{name}/git/refs/heads/{branch}", token,
                       {"sha": commit_sha, "force": False})
    if st not in (200, 201):
        print(f"  ref update FAIL: {st} {body}", file=sys.stderr)
        return 1

    print(f"\nOK  https://github.com/{owner}/{name}/tree/{branch}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="nbleo/fair_recorder")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--message", default="Update FairRecorder")
    ap.add_argument("--dry", action="store_true", help="list files only, do not push")
    args = ap.parse_args(argv)

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        print("GITHUB_TOKEN is not set", file=sys.stderr)
        return 2
    return push(args.repo, args.branch, args.message, token, dry=args.dry)


if __name__ == "__main__":
    raise SystemExit(main())
