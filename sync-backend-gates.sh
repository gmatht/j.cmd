#!/bin/bash
# ─── sync-backend-gates.sh ──────────────────────────────────────
# Sync the sh2loop backend-gate results into the otranspiler web GUI's
# example colours (www/otranspiler.html).
#
# The sh2loop loop's backend gates (setup_backends.sh --backend-gate
# <lang>) render the shared sh corpus (sh2perl/examples/*.sh +
# frontends/*/testdata/*.sh) through each backend and cache which
# files PASS in the workspace root as .<lang>_pass_set (maintained by
# harness/pass_sets.sh — see POSSIBLE_TESTING_IMPROVEMENTS.md). This
# script reads those cached pass sets and writes www/examples/gate.json;
# the GUI then colours each sidebar example button 🟢 (passes on the
# currently selected backend) / 🔴 (fails) / ⚪ (no cached gate result).
#
# Cached pass sets today (baselined 2026-08-09 in sh2loop commit
# 25e2197, refreshed whenever the loop re-seeds them):
#   .estree_pass_set → the js/estree backend (examples-only corpus)
#   .perl_pass_set   → the perl backend (examples-only corpus)
#   .sh_pass_set     → the sh backend (examples + frontends testdata)
# The other backends (c go py java rs zig) have no per-file cached
# gate results yet — their examples stay grey.
#
# The source FRONTENDS are gated by frontend-js-gate.sh (frontend → A1
# → estree render + run vs native), which caches per-file verdicts to
# .frontend_gate.tsv (lang<TAB>file<TAB>PASS|FAIL|SKIP). That only
# measures the DEFAULT js render, so the frontend corpus examples are
# coloured green/red when the GUI's target is js (grey otherwise).
# Regenerate it: (cd $SH2LOOP && ./frontend-js-gate.sh)
#
# Usage:
#   ./sync-backend-gates.sh                  # from the repo root
#   SH2LOOP=/path/to/sh2loop ./sync-backend-gates.sh
# -----------------------------------------------------------------

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
SH2LOOP="${SH2LOOP:-/home/llm/sh2loop}"

if [ ! -d "$SH2LOOP" ]; then
  echo "sh2loop workspace not found at $SH2LOOP (set SH2LOOP=…)" >&2
  exit 1
fi

python3 - "$SH2LOOP" "$REPO/www/examples" <<'PY'
import datetime, json, os, re, sys

loop, dst = sys.argv[1], sys.argv[2]

def corpus_paths(scope):
    """The gate corpus as pass-set relative paths (harness/pass_sets.sh's
    corpus() globs: examples-only, or examples + frontends testdata)."""
    paths = []
    ex = os.path.join(loop, "sh2perl", "examples")
    if scope in ("examples", "all"):
        paths += [os.path.join("sh2perl/examples", f)
                  for f in os.listdir(ex) if f.endswith(".sh")]
    if scope == "all":
        for d in os.listdir(os.path.join(loop, "frontends")):
            td = os.path.join(loop, "frontends", d, "testdata")
            if os.path.isdir(td):
                paths += [os.path.join("frontends", d, "testdata", f)
                          for f in os.listdir(td) if f.endswith(".sh")]
    return sorted(set(paths))

def pass_paths(ps_name):
    """A cached pass set (.<lang>_pass_set), sanitized to corpus paths."""
    f = os.path.join(loop, "." + ps_name + "_pass_set")
    if not os.path.isfile(f):
        return None
    with open(f) as fh:
        return sorted({l.strip() for l in fh
                       if l.strip() and not l.startswith("#")})

# lang → (pass-set name, corpus scope, corpus label, backend name)
BACKENDS = [
    ("js", "estree", "examples", "sh2perl/examples", "estree"),
    ("pl", "perl",   "examples", "sh2perl/examples", "perl"),
    ("sh", "sh",     "all",      "examples + frontends testdata", "sh"),
]

backends = {}
for lang, ps_name, scope, label, name in BACKENDS:
    cached = pass_paths(ps_name)
    if cached is None:
        print(f"  [{lang}] no cached .{ps_name}_pass_set — skipped")
        continue
    corpus = set(corpus_paths(scope))
    in_corpus = [p for p in cached if p in corpus]
    stale = [p for p in cached if p not in corpus]
    backends[lang] = {
        "name": name,
        "corpus": label,
        "total": len(corpus),
        "pass": len(in_corpus),
        "passPaths": in_corpus,
        "corpusPaths": sorted(corpus),
    }
    extra = f" ({len(stale)} stale paths dropped)" if stale else ""
    print(f"  [{lang}] {len(in_corpus)}/{len(corpus)} pass ({label}){extra}")

# source frontends → www corpus dir name (frontend-js-gate.sh's lang keys)
FRONTEND_DIR = {"sh": "sh-posix", "go": "go", "py": "py",
                "fish": "fish", "zsh": "zsh", "pl": "pl", "c": "c",
                "bat": "bat", "cpp": "cpp", "powershell": "powershell",
                "rust": "rust", "zig": "zig"}
# frontend dir → (www corpus dir, testdata subdir) — mirrors the testdata
# into www/examples/<dir>/ so the GUI ships the SAME corpus the fleet
# gates (the browser can't reach the sh2loop tree). cpp keeps its files
# in testdata_cpp/.
FRONTEND_TD = {"posix-sh-go": ("sh-posix", "testdata"), "go-sh": ("go", "testdata"),
               "py-sh-go": ("py", "testdata"), "fish-sh-go": ("fish", "testdata"),
               "zsh-sh-go": ("zsh", "testdata"), "perl-sh-go": ("pl", "testdata"),
               "c-sh-go": ("c", "testdata"), "cpp-sh-go": ("cpp", "testdata_cpp"),
               "bat-sh-go": ("bat", "testdata"), "powershell-sh-go": ("powershell", "testdata"),
               "rust-frontend": ("rust", "testdata"), "zig-sh-go": ("zig", "testdata")}
import shutil
for fe, (cdir, sub) in FRONTEND_TD.items():
    src = os.path.join(loop, "frontends", fe, sub)
    if not os.path.isdir(src):
        continue
    cdst = os.path.join(dst, cdir)
    os.makedirs(cdst, exist_ok=True)
    names = sorted(f for f in os.listdir(src) if os.path.isfile(os.path.join(src, f)))
    kept = set()
    for n in names:
        shutil.copy2(os.path.join(src, n), os.path.join(cdst, n))
        kept.add(n)
    # drop corpus files the fleet no longer carries (never the manifest)
    for old in os.listdir(cdst):
        if old != "index.json" and old not in kept:
            os.unlink(os.path.join(cdst, old))
    with open(os.path.join(cdst, "index.json"), "w") as fh:
        json.dump(names, fh)
    print(f"  [corpus:{cdir}] {len(names)} examples mirrored from {fe}/{sub}")
frontends = {}
tsv = os.path.join(loop, ".frontend_gate.tsv")
if os.path.isfile(tsv):
    results = {}
    for line in open(tsv):
        parts = line.rstrip("\n").split("\t")
        if len(parts) < 3 or parts[0] not in FRONTEND_DIR:
            continue
        results.setdefault(parts[0], {})[parts[1]] = parts[2]
    for lang, res in results.items():
        frontends[FRONTEND_DIR[lang]] = {
            "total": len(res),
            "pass": sum(1 for v in res.values() if v == "PASS"),
            "fail": sum(1 for v in res.values() if v == "FAIL"),
            "skip": sum(1 for v in res.values() if v == "SKIP"),
            "results": res,
        }
        print(f"  [frontend:{FRONTEND_DIR[lang]}] {frontends[FRONTEND_DIR[lang]]['pass']}/"
              f"{frontends[FRONTEND_DIR[lang]]['total']} pass"
              f" (skip {frontends[FRONTEND_DIR[lang]]['skip']}, fail"
              f" {frontends[FRONTEND_DIR[lang]]['fail']})")
else:
    print(f"  (no .frontend_gate.tsv — run frontend-js-gate.sh in $SH2LOOP "
          f"to cache the per-frontend verdicts; their examples stay grey)")

# Cross-product triage (harness/triage.sh in sh2loop): the frontend
# corpora rendered through EVERY backend — the pair space the per-frontend
# (default js) and per-backend (shared sh corpus) gates don't cover.
# Per frontend-example × backend verdict, plus a per-backend summary over
# the frontend corpora. Last row per pair wins.
TRIAGE_FRONTEND = {"c-sh-go": "c", "cpp-sh-go": "cpp", "bat-sh-go": "bat",
                   "py-sh-go": "py", "perl-sh-go": "pl", "posix-sh-go": "sh-posix",
                   "zsh-sh-go": "zsh", "fish-sh-go": "fish", "go-sh": "go",
                   "powershell-sh-go": "powershell", "rust-frontend": "rust",
                   "zig-sh-go": "zig",
                   # the SHARED sh corpus (sh2perl/examples) — the triage
                   # sweeps it through every backend, colouring the sh→X
                   # buttons for targets with no backend pass set
                   "sh2perl": "sh2perl"}
triage = {"frontends": {}, "backends": {}}
tv = os.path.join(loop, "triage", "verdicts.tsv")
if os.path.isfile(tv):
    last = {}
    for line in open(tv):
        p = line.rstrip("\n").split("\t")
        if len(p) < 6:
            continue
        last[(p[0], p[1], p[2])] = p[3]          # fe, be, ex -> status
    for (fe, be, ex), st in last.items():
        d = TRIAGE_FRONTEND.get(fe)
        if not d:
            continue
        triage["frontends"].setdefault(d, {}).setdefault(ex, {})[be] = st
        pb = triage["backends"].setdefault(be, {"pass": 0, "total": 0, "fail": 0})
        pb["total"] += 1
        if st in ("PASS", "PASS-RENDER"):
            pb["pass"] += 1
        elif st.startswith("FAIL"):
            pb["fail"] += 1
    if triage["frontends"]:
        n = sum(len(exs) for exs in triage["frontends"].values())
        print(f"  [triage] {n} frontend examples × {len(triage['backends'])} backends"
              f" ({sum(b['pass'] for b in triage['backends'].values())} pass cells)")
else:
    print(f"  (no triage/verdicts.tsv — run run_triage_worker.sh in $SH2LOOP;"
          f" frontend examples stay grey for non-js targets)")

data = {
    "generated": datetime.datetime.now(datetime.timezone.utc)
                            .isoformat(timespec="seconds"),
    "source": loop,
    "backends": backends,
    "frontends": frontends,
    "triage": triage,
}
os.makedirs(dst, exist_ok=True)
out = os.path.join(dst, "gate.json")

def data_only(s):
    """The gate content minus the churn metadata (generated/source change
    on EVERY run — committing those would spam history once per sweep)."""
    try:
        d = json.loads(s)
    except Exception:
        return s
    d.pop("generated", None)
    d.pop("source", None)
    return json.dumps(d, sort_keys=True)

prev = open(out).read() if os.path.exists(out) else ""
new = json.dumps(data, indent=0, sort_keys=True) + "\n"
if data_only(new) == data_only(prev):
    print(f"==> {out} unchanged (verdict data identical)")
else:
    with open(out, "w") as fh:
        fh.write(new)
    print(f"==> {out} ({os.path.getsize(out)} bytes)")
    # the verdict data changed — bump the GUI's cache-bust version so a
    # browser/proxy that cached the old `?v=N` can't keep serving the
    # previous snapshot (the fetch also uses cache:'no-cache').
    hp = os.path.join(dst, "..", "otranspiler.html")
    try:
        html = open(hp).read()
    except FileNotFoundError:
        html = None
    if html is not None:
        m = re.search(r'const GATE_VERSION = "(\d+)"', html)
        if m:
            nv = str(int(m.group(1)) + 1)
            open(hp, "w").write(html.replace(m.group(0), 'const GATE_VERSION = "' + nv + '"'))
            print("GATE_VERSION -> " + nv)
PY
