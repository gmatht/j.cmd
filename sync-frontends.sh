#!/bin/bash
# ─── sync-frontends.sh ──────────────────────────────────────────
# Re-vendor the Go frontend sources that the otranspiler busybox
# (www/wasm-bin/otranspiler-busybox.wasm, built by build-wasm-busybox.sh)
# is merged from.
#
# The file table below mirrors FRONTEND_FILES in src/busybox.js — keep
# them in sync when a frontend gains a file. After syncing, rebuild:
#   ./build-wasm-busybox.sh
#
# Three vendored-only adaptations are re-applied idempotently after every
# copy (upstream must stay untouched — workers edit it live):
#   bat-sh-go/bat.go ... Shir adapter (upstream exposes Parse only;
#                        the merge dispatcher needs one Shir per lib)
#   go-sh/go-sh.go ..... drop the runtime/debug import + PANICSTACK
#                        stack dump (the browser Go toolchain's GOROOT
#                        bundle has no runtime/debug; diagnostic only)
#   go-sh / py-sh-go ... inline the shir-emit-go emitter instead of
#                        importing it: the merged busybox is one
#                        stdlib-only file. The inlined copy is
#                        www/bin/shir-emit-go/emit.go with the
#                        shiremit identifiers renamed out of the
#                        frontend's namespace (JSON output unchanged).
#
# The cgo guard refuses the whole sync if any NORMALLY-pure frontend
# gains a non-wasm-buildable import ("C", runtime/debug, runtime/cgo,
# *tree-sitter*). cpp-sh-go is the KNOWN exception: upstream is
# cgo/tree-sitter, so its vendored pure-Go tokenizer is NEVER touched
# (only refreshed by hand, see the v30 commit).
#
# Usage:
#   ./sync-frontends.sh           # copy changed files, re-apply adapters
#   ./sync-frontends.sh --check   # report drift, change nothing (exit 1 if any)
#   SH2LOOP=/path/to/sh2loop ./sync-frontends.sh
#
# Both adaptations need gofmt on PATH (the inlined emitter is gofmt'd
# like the upstream file, so the result stays reproducible).
# -----------------------------------------------------------------

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
SH2LOOP="${SH2LOOP:-/home/llm/sh2loop}"
UP="$SH2LOOP/frontends"
V="$REPO/www/bin"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

[ -d "$UP" ] || { echo "error: frontends not found at $UP (set SH2LOOP)" >&2; exit 2; }

# dir:space-separated-files (relative to frontends/<dir> and www/bin/<dir>)
TABLE="
bat-sh-go:bat.go
c-sh-go:main.go cmd/c-sh-go/main.go
fish-sh-go:fish-sh-go.go cmd/fish-sh-go/main.go
go-sh:go-sh.go cmd/go-sh/main.go
perl-sh-go:main.go cmd/perl-sh-go/main.go
py-sh-go:main.go cmd/py-sh-go/main.go
posix-sh-go:main.go analysis.go lowering.go
zsh-sh-go:main.go analysis.go lowering.go cmd/zsh-sh-go/main.go
zig-sh-go:main.go
shir-emit-go:emit.go
"

# ── 1. cgo guard: pre-scan upstream for non-wasm-buildable imports ──
# (comments may mention tree-sitter freely — only real imports count)
echo "── cgo guard ──"
VIOLATION=0
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  dir="${entry%%:*}"; files="${entry#*:}"
  for f in $files; do
    src="$UP/$dir/$f"
    [ -f "$src" ] || { echo "  MISSING upstream: $dir/$f"; continue; }
    # extract double-quoted imports, one per line. runtime/debug in
    # go-sh/go-sh.go is EXPECTED here — the §3 adapter strips it on
    # copy (the post-copy guard below verifies it is really gone).
    bad=$(sed -n '/^import (/,/^)/p; /^import "/p' "$src" \
      | grep -oE '"[^"]+"' | tr -d '"' \
      | grep -xE 'C|runtime/cgo' \
      || true)
    bad_tree=$(sed -n '/^import (/,/^)/p; /^import "/p' "$src" \
      | grep -oE '"[^"]+"' | tr -d '"' \
      | grep -E 'tree-sitter|tree_sitter' \
      || true)
    if [ -n "$bad$bad_tree" ]; then
      echo "  VIOLATION $dir/$f imports: $bad $bad_tree"
      VIOLATION=1
    fi
  done
done <<< "$TABLE"
# cpp-sh-go/main.go is EXPECTED to be cgo — verify it still is (if it ever
# goes pure-Go again, someone must consciously re-vendor it)
if grep -qE '"C"|tree-sitter' "$UP/cpp-sh-go/main.go" 2>/dev/null; then
  echo "  cpp-sh-go: still cgo/tree-sitter upstream — vendored pure-Go tokenizer untouched (policy)"
else
  echo "  NOTE cpp-sh-go/main.go looks pure-Go upstream — consider re-vendoring by hand"
fi
[ "$VIOLATION" = 1 ] && { echo "error: cgo guard failed — sync refused" >&2; exit 1; }
echo "  clean"

# files that ALWAYS differ by design (vendored-only adapters, §3) —
# reported separately, never a drift failure
EXPECTED_DRIFT="go-sh/go-sh.go bat-sh-go/bat.go fish-sh-go/fish-sh-go.go perl-sh-go/main.go"
is_expected() { case " $EXPECTED_DRIFT " in *" $1 "*) return 0;; esac; return 1; }

# ── 2. copy ───────────────────────────────────────────────────────
echo "── sync ──"
SYNCED=0; UNEXPECTED=0
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  dir="${entry%%:*}"; files="${entry#*:}"
  for f in $files; do
    src="$UP/$dir/$f"; dst="$V/$dir/$f"
    [ -f "$src" ] || { echo "  SKIP (no upstream): $dir/$f"; continue; }
    if ! diff -q "$dst" "$src" >/dev/null 2>&1; then
      if is_expected "$dir/$f"; then
        echo "  DIFFERS (expected adapter): $dir/$f"
      else
        echo "  DIFFERS: $dir/$f"; UNEXPECTED=$((UNEXPECTED + 1))
      fi
      if [ "$CHECK" = 0 ]; then cp "$src" "$dst"; SYNCED=$((SYNCED + 1)); fi
    fi
  done
done <<< "$TABLE"
# new upstream .go files the merge table doesn't know about
NEWFILES=0
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  dir="${entry%%:*}"
  while IFS= read -r gf; do
    rel="${gf#$UP/$dir/}"
    case "$rel" in testdata/*|testdata_cpp/*|grammars/*) continue;; esac
    found=0
    for f in ${entry#*:}; do [ "$rel" = "$f" ] && found=1; done
    if [ "$found" = 0 ]; then echo "  NEW UPSTREAM FILE not vendored: $dir/$rel"; NEWFILES=$((NEWFILES + 1)); fi
  done < <(find "$UP/$dir" -maxdepth 2 -name '*.go' 2>/dev/null)
done <<< "$TABLE"
[ "$CHECK" = 0 ] && echo "  synced $SYNCED file(s)" || echo "  (check mode — nothing copied)"

# ── 3. vendored-only adapters (idempotent) ─────────────────────────
if [ "$CHECK" = 0 ]; then
echo "── adapters ──"
# bat: Shir wrapper around Parse
if ! grep -q "^func Shir" "$V/bat-sh-go/bat.go"; then
  python3 - "$V/bat-sh-go/bat.go" <<'EOF'
import sys
p = sys.argv[1]; s = open(p).read()
old = "// Parse parses batch source into an A1 shIR program.\nfunc Parse(src string) (*shiremit.Program, error) {"
assert s.count(old) == 1, "bat adapter anchor moved — fix sync-frontends.sh"
new = ("// Shir — the fleet entry point (src → A1 shIR JSON bytes), the same\n"
"// contract every other frontend (c/fish/go/py/zsh/…) exposes to the\n"
"// merged busybox dispatcher. bat-sh-go upstream refactored to the\n"
"// library Parse → shared shir-emit-go Emit split; this thin adapter\n"
"// keeps the busybox merge uniform (one Shir per frontend).\n"
"func Shir(src string) ([]byte, error) {\n"
"\tprog, err := Parse(src)\n"
"\tif err != nil {\n"
"\t\treturn nil, err\n"
"\t}\n"
"\treturn shiremit.Emit(prog)\n"
"}\n\n" + old)
open(p, "w").write(s.replace(old, new))
print("  bat-sh-go: Shir adapter (re)applied")
EOF
else
  echo "  bat-sh-go: Shir adapter present"
fi
# go-sh: drop runtime/debug (browser GOROOT lacks it)
if grep -q '"runtime/debug"' "$V/go-sh/go-sh.go"; then
  python3 - "$V/go-sh/go-sh.go" <<'EOF'
import sys
p = sys.argv[1]; s = open(p).read()
old_imp = '\t"runtime/debug"\n'
assert s.count(old_imp) == 1, "go-sh import anchor moved — fix sync-frontends.sh"
s = s.replace(old_imp, '\t// NOTE (vendored busybox): upstream imports runtime/debug for a\n\t// PANICSTACK stack dump in run()'"'"'s panic recovery — the browser Go\n\t// toolchain'"'"'s GOROOT bundle has no runtime/debug, so the vendored\n\t// copy drops that one diagnostic call (kept in sh2loop upstream).\n')
old_call = '\t\t\tif os.Getenv("PANICSTACK") != "" {\n\t\t\t\tdebug.PrintStack()\n\t\t\t}\n'
assert s.count(old_call) == 1, "go-sh PrintStack anchor moved — fix sync-frontends.sh"
s = s.replace(old_call, '')
open(p, 'w').write(s)
print("  go-sh: runtime/debug import + PrintStack dropped")
EOF
else
  echo "  go-sh: no runtime/debug import"
fi
# bat/go/fish/perl/py: inline the shir-emit-go emitter (stdlib-only
# merge). The import leaves the frontend; the emitter's code is appended
# with its identifiers renamed out of the frontend's namespace and the
# two upstream call shapes rewritten (`&shiremit.Program{...}` and
# `shiremit.Emit(prog)` become the inlined names). gofmt normalises the
# result so a re-sync is a no-op.
for fe in bat-sh-go/bat.go go-sh/go-sh.go fish-sh-go/fish-sh-go.go perl-sh-go/main.go py-sh-go/main.go; do
  if grep -q '"github.com/gmatht/sh2loop/frontends/shir-emit-go"' "$V/$fe"; then
    python3 - "$V/$fe" "$V/shir-emit-go/emit.go" <<'EOF'
import re, sys, subprocess
dst, emit = sys.argv[1], sys.argv[2]
pre = "shiremit"
s = open(dst).read()
imp = '\n\tshiremit "github.com/gmatht/sh2loop/frontends/shir-emit-go"\n'
assert s.count(imp) == 1, "emit import anchor moved — fix sync-frontends.sh"
s = s.replace(imp, "")
if not re.search(r'\bencoding/json\b', s):
    s = s.replace('import (\n', 'import (\n\t"encoding/json"\n', 1)
s = s.replace("shiremit.", pre)
seg = open(emit).read().replace("package shiremit\n", "", 1)
seg = re.sub(r"\bshiremit\.", pre, seg)
seg = seg.replace('import (\n\t"encoding/json"\n\t"sort"\n)\n', "", 1)
seg = re.sub(r"\bProgram\b", pre + "Program", seg)
seg = re.sub(r"\bVarType\b", pre + "VarType", seg)
seg = re.sub(r"\bSub\b", pre + "Sub", seg)
seg = re.sub(r"\bFloatType\b", pre + "FloatType", seg)
seg = re.sub(r"\bEmitToMap\b", pre + "EmitToMap", seg)
seg = re.sub(r"\bSortedKeys\b", pre + "SortedKeys", seg)
seg = re.sub(r"\bContractVersion\b", pre + "ContractVersion", seg)
seg = seg.replace("toAnySlice", pre + "ToAnySlice").replace("toAnySubs", pre + "ToAnySubs").replace("toAnyStmts", pre + "ToAnyStmts")
seg = seg.replace("func Emit(prog *", "func " + pre + "Emit(prog *")
seg = seg.replace('"type":             "' + pre + 'Program",', '"type":             "Program",')
seg = seg.replace('`json:"type"` // "' + pre + 'Sub"', '`json:"type"` // "Sub"')
# the copied doc comments named the upstream package; keep them prose
seg = seg.replace(pre + "Program type", "Program type")
hdr = ("// ─────────────────────────────────────────────────────────────────────\n"
       "// The A1 emitter, INLINED from upstream shir-emit-go (package shiremit)\n"
       "// by sync-frontends.sh: the merged busybox is one stdlib-only file, so\n"
       "// the emitter ships inside the frontend instead of as a module import.\n"
       "// The JSON it emits is unchanged.\n"
       "// ─────────────────────────────────────────────────────────────────────\n\n")
s = s.rstrip("\n") + "\n\n" + hdr + seg.rstrip("\n") + "\n"
open(dst, "w").write(s)
subprocess.run(["gofmt", "-w", dst], check=True)
print("  " + dst.split("/www/bin/")[1] + ": shir-emit-go inlined")
EOF
  else
    echo "  ${fe%%/*}: emitter inlined"
  fi
done
fi
echo "done — next: ./build-wasm-busybox.sh"
