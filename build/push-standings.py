#!/usr/bin/env python3
"""Publish the local standings document through the science upload door.

Reads  : assets/data/leaderboard.json   (local copy, also the site's offline fallback)
Writes : POST {API}/eeg/upload/doc/qm3  (FULL REPLACE — validated, versioned, guarded)
Auth   : an UPLOAD KEY — scoped to this one job. Resolved in this order:
           1. QM3_UPLOAD_KEY environment variable (overrides everything)
           2. build/.qm3-upload-key file (git-ignored, must be chmod 600)

Why this changed, and it is the point of the change:
  This script used to POST to /admin/documents/qm3 with a FULL ADMIN TOKEN. That token opens
  accounts, credits, bookings and client email texts — none of which publishing a leaderboard
  needs. A key that can only upload cannot be used for anything else if it leaks, and it can be
  revoked for one holder without stopping the others.
  The old door also accepted any JSON at all: no refusal of a person's name in a row, no refusal
  of coordinates precise enough to indicate a home, on a document that is world-readable and
  that nothing can un-publish. This door validates before it stores, whole or not at all.

  There is NO fallback to the old door. A guard a script can step around is not a guard.

Usage:
    python3 build/push-standings.py             # rehearse, then publish, then verify
    python3 build/push-standings.py --dry-run   # rehearse on the server only, write nothing
"""
import json
import os
import stat
import sys
import urllib.error
import urllib.request

API = "https://api.allherelounge.com"
WRITE_URL = API + "/eeg/upload/doc/qm3"
READ_URL = API + "/eeg/standings/qm3"

# How a machine presents its upload key — its OWN header, never `Authorization`.
# On these routes `Authorization: Bearer` already means "a session token". Carrying two kinds
# of credential on one header would make a 401 stop saying WHICH one failed: "key revoked" and
# "session expired" would look identical. Same reason this API already uses X-Science-Key and
# x-cron-key rather than folding them into Authorization.
AUTH_HEADER = "X-Upload-Key"
AUTH_PREFIX = ""

ROOT = os.path.dirname(os.path.abspath(os.path.join(__file__, "..")))
LOCAL = os.path.join(ROOT, "assets", "data", "leaderboard.json")
KEY_FILE = os.path.join(ROOT, "build", ".qm3-upload-key")
OLD_TOKEN_FILE = os.path.join(ROOT, "build", ".qm3-token")


def read_key():
    """Env var wins; otherwise the git-ignored key file."""
    env = os.environ.get("QM3_UPLOAD_KEY")
    if env:
        return env.strip(), "QM3_UPLOAD_KEY env var"

    if not os.path.exists(KEY_FILE):
        sys.exit(
            "ERROR: no upload key.\n"
            "  Put it in build/.qm3-upload-key (chmod 600), or export QM3_UPLOAD_KEY.\n"
            "  Ask whoever holds eeg.keys for one — it may upload and nothing else.\n"
            "  Never commit it: this repo is public."
        )

    mode = stat.S_IMODE(os.stat(KEY_FILE).st_mode)
    if mode & 0o077:
        sys.exit("ERROR: build/.qm3-upload-key is readable by others (%o). Run: chmod 600 build/.qm3-upload-key" % mode)

    with open(KEY_FILE) as f:
        key = f.read().strip()
    if not key:
        sys.exit("ERROR: build/.qm3-upload-key is empty.")
    return key, "build/.qm3-upload-key"


def warn_old_token():
    """The admin token this script used to need is now useless here — and it still opens
    everything else. Saying so is the only way it gets deleted."""
    if os.path.exists(OLD_TOKEN_FILE):
        print("WARNING: build/.qm3-token still exists. This script no longer uses it, but it is\n"
              "         a full admin token sitting in a file: it opens accounts, credits and\n"
              "         bookings. Delete it, and rotate it if it was ever shared.\n")


def load_local():
    with open(LOCAL, "rb") as f:
        raw = f.read()
    doc = json.loads(raw)  # fails loudly on malformed JSON
    if not isinstance(doc, dict) or "meta" not in doc or "entries" not in doc:
        sys.exit("ERROR: not a valid standings document (needs meta + entries).")
    if not doc["entries"]:
        sys.exit("ERROR: refusing to publish an empty entries list.")
    return raw, doc


def summarize(doc, label):
    es = doc.get("entries", [])
    print("  %-5s meta:%d keys  entries:%d (scored %d / dots %d / vip %d)  updated:%s" % (
        label, len(doc.get("meta", {})), len(es),
        sum(1 for e in es if isinstance(e.get("cmi"), (int, float))),
        sum(1 for e in es if e.get("dot")),
        sum(1 for e in es if e.get("vip")),
        doc.get("meta", {}).get("updated")))


def live_etag():
    """The identity of the file currently published, read from the public document. Sent back
    as If-Match so a replace cannot silently overwrite a version someone else pushed while this
    one was being prepared. Absent (or hidden by the server) → no precondition, and the write
    still goes through: a missing guard must not become a refusal to publish."""
    try:
        req = urllib.request.Request(READ_URL, method="HEAD")
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.headers.get("ETag")
    except Exception:
        return None


def show_refusal(code, body):
    """The server says which field and which row. Printing that verbatim is the whole point:
    'invalid' is useless to someone holding a 4 MB file."""
    try:
        j = json.loads(body)
    except ValueError:
        print("HTTP %s: %s" % (code, body[:400]))
        return
    print("Refused (%s): %s" % (code, j.get("error", "no code given")))
    for d in (j.get("detail") or []):
        where = " ".join(x for x in [d.get("field", ""), ("row %s" % d["row"]) if d.get("row") is not None else ""] if x)
        line = "  - %-34s %s" % (where or "—", d.get("hint") or d.get("code") or "")
        if d.get("expected") is not None:
            line += "\n      expected: %s" % (d["expected"],)
        # `got` is deliberately absent when the refusal is about personal data: repeating the
        # caught value here would copy it into a terminal, a screenshot and the thread that follows.
        if "got" in d:
            line += "\n      found:    %s" % (json.dumps(d["got"])[:120],)
        print(line)
    if j.get("detail_truncated"):
        print("  … and %s more — fix these first." % j["detail_truncated"])


def send(raw, key, dry, etag=None):
    url = WRITE_URL + ("?dry=1" if dry else "")
    headers = {AUTH_HEADER: AUTH_PREFIX + key, "Content-Type": "application/json"}
    if not dry and etag:
        headers["If-Match"] = etag
    req = urllib.request.Request(url, data=raw, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if e.code == 404:
            sys.exit("ERROR: %s does not exist on this server.\n"
                     "  The upload door is not deployed yet. Nothing was sent, and there is\n"
                     "  nothing wrong with the file. This script does not fall back to the old\n"
                     "  admin route on purpose." % url)
        if e.code == 412:
            sys.exit("ERROR: someone replaced the published document while this one was being\n"
                     "  prepared. Nothing was written. Re-read the live file, redo the local\n"
                     "  build against it, then run this again.")
        if e.code in (401, 403):
            sys.exit("ERROR: HTTP %s — this key may not upload this document (or it was revoked).\n%s"
                     % (e.code, body[:300]))
        show_refusal(e.code, body)
        sys.exit(1)
    except urllib.error.URLError as e:
        sys.exit("ERROR: cannot reach the API — %s" % e.reason)


def main():
    raw, doc = load_local()
    print("Local document:")
    summarize(doc, "local")
    warn_old_token()

    key, source = read_key()
    print("Key source: %s\n" % source)

    # The rehearsal is the same request one character apart: what it validated IS what the
    # write receives — same route, same size cap, same validator.
    print("Rehearsing on the server (nothing is written)…")
    res = send(raw, key, dry=True)
    stored = res.get("stored") or {}
    print("  accepted: %s entries, %s bytes" % (stored.get("entries", "?"), stored.get("bytes", "?")))

    if "--dry-run" in sys.argv:
        print("\n[--dry-run] the server accepted this file. Nothing was written.")
        return

    etag = live_etag()
    print("\nPublishing to %s (full replace)%s…" % (WRITE_URL, " guarded by If-Match" if etag else ""))
    res = send(raw, key, dry=False, etag=etag)
    # A write that answers with a rehearsal verdict must never be reported as published.
    if res.get("dry") is True:
        sys.exit("ERROR: the server answered with a rehearsal verdict for a real upload.\n"
                 "  NOTHING WAS PUBLISHED. Tell whoever runs the API.")
    stored = res.get("stored") or {}
    print("Stored: version %s (replaced %s), %s entries, sha256 %s"
          % (stored.get("version", "?"), stored.get("replaced_version", "—"),
             stored.get("entries", "?"), (stored.get("sha256") or "—")[:16]))

    # Independent control read: does the published document now match what we sent?
    req = urllib.request.Request(READ_URL, headers={"Origin": "https://allheregeneva.github.io"})
    with urllib.request.urlopen(req, timeout=10) as r:
        live = json.loads(r.read())
    print("Control read from the published document:")
    summarize(live, "live")

    if live == doc:
        print("\nOK — the published document matches local, field by field.")
        sys.exit(0)
    print("\nWARNING — the published document differs from local. Inspect before trusting it.")
    sys.exit(2)


if __name__ == "__main__":
    main()
