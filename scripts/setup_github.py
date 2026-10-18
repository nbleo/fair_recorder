"""One-shot GitHub setup for FairRecorder.

    GITHUB_TOKEN=<pat> python scripts/setup_github.py

What it does
------------
1. Resolves (or creates) two repositories:
     * <code-repo>  PUBLIC   — the PWA source, published with GitHub Pages
     * <data-repo>  PRIVATE  — where the phone syncs supplier records
2. Pushes the working tree **through the GitHub REST API**
   (git-over-HTTPS is blocked on some networks; api.github.com is not).
3. Switches GitHub Pages on with "GitHub Actions" as the build source.

Notes
-----
* The token is read from the environment only — never written to disk,
  never stored in .git/config.
* Only files tracked by git are uploaded, so `.gitignore`d items
  (config.json, output/, inbox/) stay local.
* A read-only token cannot write: the script detects that and stops with
  an actionable message instead of failing half-way.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import push_via_api as P  # noqa: E402

API = "https://api.github.com"
ROOT = Path(__file__).resolve().parent.parent
WRITE_HINT = ("Your token can read but not write. Generate a new one with\n"
              "  Repository permissions -> Contents: Read and write, Pages: Read and write\n"
              "or use a classic token with the 'repo' + 'workflow' scopes.")


def api(method: str, path: str, token: str, body: dict | None = None) -> tuple[int, object]:
    status, out = P.api(method, path, token, body)
    return status, out


def resolve_repo(token: str, owner: str, name: str, private: bool, desc: str) -> dict | None:
    """Return the repo dict, or None if it does not exist / cannot be created."""
    status, body = api("GET", f"/repos/{owner}/{name}", token)
    if status == 200 and isinstance(body, dict):
        print(f"  {body['full_name']}  (private={body['private']})  [exists]")
        return body

    status, body = api("POST", "/user/repos", token,
                       {"name": name, "private": private, "description": desc,
                        "auto_init": private})
    if status in (200, 201) and isinstance(body, dict):
        print(f"  {body['full_name']}  (private={body['private']})  [created]")
        return body

    print(f"  {owner}/{name}: not found and cannot be created (HTTP {status})")
    return None


DATA_README = """# FairRecorder — private supplier store

Written by the FairRecorder PWA on your phone. **Keep this repository private.**

## Layout — one namespace per person

    users/<github-login>/fairs/<fair-id>/meta.json            counts, chunk index, crypto params
    users/<github-login>/fairs/<fair-id>/suppliers-<n>.json   records, 200 per chunk
    users/<github-login>/fairs/<fair-id>/assets/<photo>.jpg   product / business-card photos

Each person writes only under their own `users/<login>/` prefix, so several
people can share one private repo without overwriting each other.

`meta.json` is intentionally plaintext (counts + the PBKDF2 salt); the record
chunks and photos are AES-GCM ciphertext when encryption is switched on in the app.

## Access control

* Read access = repository access. Add someone at
  **Settings → Collaborators → Add people** — do *not* make this repo public.
* The app refuses to upload to a public repository, and refuses the public
  code repository outright.

## What does NOT belong here

Anything about the program itself. The app source lives in the public repo and
is deployed with GitHub Pages; supplier data must never be pushed there.
"""

DATA_GITIGNORE = """.DS_Store
Thumbs.db
*.tmp
"""


def seed_data_repo(token: str, owner: str, repo: str, branch: str) -> None:
    """Give the private store a README + .gitignore so the first sync has a base."""
    import base64

    for path, text in (("README.md", DATA_README), (".gitignore", DATA_GITIGNORE)):
        status, body = api("GET", f"/repos/{owner}/{repo}/contents/{path}", token)
        if status == 200:
            print(f"  {path}: already present")
            continue
        status, body = api("PUT", f"/repos/{owner}/{repo}/contents/{path}", token, {
            "message": f"Initialise private store ({path})",
            "content": base64.b64encode(text.encode("utf-8")).decode("ascii"),
            "branch": branch,
        })
        print(f"  {path}: {'created' if status in (200, 201) else f'FAILED {status} {body}'}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--owner", default="", help="GitHub account (defaults to the token owner)")
    ap.add_argument("--code-repo", default="fair_recorder", help="public repo holding the PWA")
    ap.add_argument("--data-repo", default="fairrecorder-data", help="private repo holding records")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--message", default="FairRecorder: offline supplier capture PWA + report pipeline")
    ap.add_argument("--skip-push", action="store_true")
    args = ap.parse_args()

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        raise SystemExit("Set GITHUB_TOKEN first, e.g.\n"
                         "  GITHUB_TOKEN=<pat> python scripts/setup_github.py")

    status, me = api("GET", "/user", token)
    if status != 200 or not isinstance(me, dict):
        raise SystemExit(f"cannot authenticate: HTTP {status} {me}")
    owner = args.owner or me["login"]
    print(f"authenticated as {me['login']}  ->  owner '{owner}'\n")

    # The two repos must never be the same: one is public (Pages), one is private.
    if args.data_repo.lower() == args.code_repo.lower():
        raise SystemExit("Refusing to run: --data-repo and --code-repo are the same.\n"
                         "The code repo is public (GitHub Pages serves it to anyone) while\n"
                         "supplier data must live in a separate PRIVATE repository.")

    print("repositories")
    code = resolve_repo(token, owner, args.code_repo, private=False,
                        desc="Offline-first supplier capture PWA for trade fairs (code only)")
    if code is None:
        raise SystemExit(f"Create the public repo first: https://github.com/new  name={args.code_repo}")

    data = resolve_repo(token, owner, args.data_repo, private=True,
                        desc="FairRecorder supplier records - private backup store")
    if data is None:
        print(f"  -> the name may already be taken but invisible to this token.\n"
              f"     Open https://github.com/{owner}/{args.data_repo} in a browser:\n"
              f"       * if it exists  -> add it to the token's repository access list\n"
              f"       * if 404        -> create it at https://github.com/new (Private)\n"
              "     A fine-grained token scoped to 'Only select repositories' cannot see\n"
              "     repositories that are outside its selection, even ones it just created.")
    data_branch = (data or {}).get("default_branch", "main")
    if data is not None:
        print("\nseeding the private store")
        seed_data_repo(token, owner, args.data_repo, data_branch)

    if args.skip_push:
        print("skipping push (--skip-push)")
        return 0

    print(f"\npushing {owner}/{args.code_repo} via the REST API (git protocol is not used)")
    rc = P.push(f"{owner}/{args.code_repo}", args.branch, args.message, token)
    if rc != 0:
        raise SystemExit("push failed.\n" + WRITE_HINT)

    status, body = api("POST", f"/repos/{owner}/{args.code_repo}/pages", token,
                       {"build_type": "workflow"})
    if status in (200, 201, 204):
        print("Pages     : enabled — build source is GitHub Actions")
    elif status == 409 or (isinstance(body, str) and "already" in body.lower()):
        print("Pages     : already enabled")
    else:
        print(f"Pages     : could not enable automatically (HTTP {status})")
        print(f"            do it once at https://github.com/{owner}/{args.code_repo}/settings/pages"
              "  ->  Source: GitHub Actions")

    print()
    print("Two repositories, two jobs:")
    print(f"  PUBLIC  {owner}/{args.code_repo:<20} program only -> Pages")
    print(f"  PRIVATE {owner}/{args.data_repo:<20} supplier records, per-person namespaces")
    print()
    print("Fill in the app's Cloud Sync screen with:")
    print(f"  owner      = {owner}")
    print(f"  repo       = {args.data_repo}   <-- private")
    print(f"  branch     = {data_branch}")
    print("  root       = users")
    print("  namespace  = (auto-filled from your GitHub login after 'test connection')")
    print()
    print("Pull records down for reporting:")
    print(f"  GITHUB_TOKEN=<pat> python scripts/pull_cloud.py --owner {owner} "
          f"--repo {args.data_repo} --user <login> --all-fairs")
    print()
    print(f"PWA URL (live after the workflow finishes): "
          f"https://{owner}.github.io/{args.code_repo}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
