#!/usr/bin/env python3
"""One command to ship a standings change, in the order that can't leave a stale fallback.

    python3 build/release.py -m "message de commit"

Steps: show what changes -> confirm -> publish to AllHereDB -> bump the ?v= params
-> commit -> push -> verify the base matches.

The base is published FIRST: the committed file is only the offline fallback, so it
must never be newer than the source. If the run dies halfway, the fallback is at
worst older than the base — never the reverse.

    --dry-run   show everything, touch nothing (never reads the token)
    --yes       skip the confirmation prompt
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL = os.path.join(ROOT, "assets", "data", "leaderboard.json")
INDEX = os.path.join(ROOT, "index.html")
READ_URL = "https://api.allherelounge.com/eeg/standings/qm3"


def git(*a, **kw):
    return subprocess.run(("git",) + a, cwd=ROOT, text=True,
                          capture_output=True, **kw).stdout.strip()


def flat(x, p=""):
    """Flatten to /path -> scalar, so we can diff field by field."""
    out = {}
    if isinstance(x, dict):
        for k, v in x.items():
            out.update(flat(v, p + "/" + str(k)))
    elif isinstance(x, list):
        for i, v in enumerate(x):
            out.update(flat(v, p + "/" + str(i)))
    else:
        out[p] = x
    return out


def fetch_base():
    try:
        req = urllib.request.Request(READ_URL, headers={"Origin": "https://allheregeneva.github.io"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        print("  ! base injoignable (%s) — impossible de comparer." % e)
        return None


def bump_data_version():
    """Nudge leaderboard.json?v=N so browsers refetch the fallback."""
    html = open(INDEX, encoding="utf-8").read()
    m = re.search(r"leaderboard\.json\?v=(\d+)", html)
    if not m:
        sys.exit("ERROR: no leaderboard.json?v=N found in index.html")
    new = int(m.group(1)) + 1
    open(INDEX, "w", encoding="utf-8").write(
        html.replace(m.group(0), "leaderboard.json?v=%d" % new))
    return new


def main():
    dry = "--dry-run" in sys.argv
    yes = "--yes" in sys.argv
    msg = None
    if "-m" in sys.argv:
        i = sys.argv.index("-m")
        if i + 1 < len(sys.argv):
            msg = sys.argv[i + 1]

    doc = json.load(open(LOCAL))

    # --- what would change in the base ---
    print("=== Base vs fichier local ===")
    base = fetch_base()
    changes = []
    if base is not None:
        fb, fd = flat(base), flat(doc)
        for k in sorted(set(fb) | set(fd)):
            if fb.get(k) != fd.get(k):
                changes.append((k, fb.get(k), fd.get(k)))
        if not changes:
            print("  identiques — rien à publier en base.")
        for k, old, new in changes:
            print("  %s\n     base  : %r\n     local : %r" % (k, old, new))

    # --- what would be committed ---
    print("\n=== Fichiers qui seraient commités ===")
    status = git("status", "--porcelain")
    print("  " + ("\n  ".join(status.splitlines()) if status else "(aucun)"))
    print("  + index.html (bump du ?v=)")

    if dry:
        print("\n[--dry-run] rien envoyé, rien commité, token non lu.")
        return
    if not changes and not status:
        print("\nRien à faire.")
        return
    if not msg:
        sys.exit("\nERROR: message de commit manquant. Utilise -m \"…\".")

    if not yes:
        try:
            if input("\nPublier en base, puis commiter et pousser ? [y/N] ").strip().lower() != "y":
                sys.exit("Annulé.")
        except EOFError:
            sys.exit("ERROR: pas de terminal interactif — relance avec --yes.")

    # --- 1. base first: the fallback must never be newer than the source ---
    if changes:
        print("\n--- Publication en base ---")
        if subprocess.run([sys.executable, os.path.join(ROOT, "build", "push-standings.py")],
                          cwd=ROOT).returncode != 0:
            sys.exit("ERROR: publication échouée — rien n'a été commité.")
    else:
        print("\n--- Base déjà à jour, publication ignorée ---")

    # --- 2. cache-busting, then commit the fallback ---
    print("\n--- Bump des versions ---")
    print("  leaderboard.json?v=%d" % bump_data_version())
    subprocess.run([sys.executable, os.path.join(ROOT, "build", "bump-version.py")], cwd=ROOT)

    print("\n--- Commit & push ---")
    subprocess.run(["git", "add", "-u"], cwd=ROOT, check=True)
    subprocess.run(["git", "commit", "-q", "-m", msg], cwd=ROOT, check=True)
    subprocess.run(["git", "push", "-q", "origin", "main"], cwd=ROOT, check=True)
    print("  " + git("log", "--oneline", "-1"))

    # --- 3. verify ---
    print("\n--- Vérification ---")
    live = fetch_base()
    if live == json.load(open(LOCAL)):
        print("  OK — la base correspond au fichier local.")
    else:
        print("  ATTENTION — la base diffère encore du local. À inspecter.")
        sys.exit(2)


if __name__ == "__main__":
    main()
