#!/bin/bash
# ─── pgo-transpile.sh — profile-guided optimisation of otranspilerl ──
# Builds the native otranspilerl-cli (the SAME Rust reactor the browser
# wasm is compiled from — otranspilerl/src, with the debashl/sh2perl
# core) with LLVM PGO, drives it over the game's transpile workload
# (www/bin/mimecroft.sh + its texture generators), and rebuilds with
# the profile. Benchmarks before/after.
#
# NOTE: rustc has no PGO support for wasm32-wasip1 (the LLVM profile
# runtime isn't available on wasm targets), so the profile is taken on
# the NATIVE build. The functions are the same code the wasm runs —
# the profile shows where the transpile time goes and the native binary
# gets the PGO speedup.
#
# Usage: ./pgo-transpile.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
OTR="${OTRANSPILERL:-/home/llm/sh2loop/otranspilerl}"
CLI="$OTR/target/release/otranspilerl-cli"
PROF_DIR="${PGO_PROF_DIR:-/tmp/pgo-transpile-prof}"
PROF_DATA="${PGO_PROF_DATA:-/tmp/pgo-transpile.profdata}"
BASE_JSON=/tmp/pgo-transpile-baseline.json
PGO_JSON=/tmp/pgo-transpile-pgo.json

if [ ! -f "$CLI" ]; then
  echo "error: $CLI not found — build it first (cargo build --release in $OTR)" >&2
  exit 1
fi

bench() { # $1 = out json path
  (cd "$REPO" && node bench-transpile.mjs --native --json 2>/dev/null > "$1")
}

# ─── baseline ─────────────────────────────────────────────────────
echo "== baseline (current release CLI) =="
bench "$BASE_JSON"
python3 - "$BASE_JSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"  total native: {d['totalNativeMs']:.1f} ms over {len(d['files'])} files")
print(f"  mimecroft.sh: {d['files'][0]['nativeMs']:.1f} ms")
PY

# ─── 1. instrumented build ────────────────────────────────────────
rm -rf "$PROF_DIR"; mkdir -p "$PROF_DIR"
echo ""
echo "== build instrumented CLI (RUSTFLAGS=-Cprofile-generate) =="
echo "   (this takes a few minutes — the full otranspilerl + debashl)"
rm -f "$CLI.baseline"
( cd "$OTR" && RUSTFLAGS="-Cprofile-generate=$PROF_DIR" cargo build --release )

# ─── 2. drive the workload through the instrumented binary ────────
echo ""
echo "== profile workload (mimecroft.sh + textures through the CLI) =="
(cd "$REPO" && node bench-transpile.mjs --profile)
PROFRAWS=$(ls "$PROF_DIR"/*.profraw 2>/dev/null | wc -l)
echo "   profraw files: $PROFRAWS"
if [ "$PROFRAWS" -eq 0 ]; then
  echo "error: no .profraw produced — the instrumented build did not emit profiles" >&2
  exit 1
fi

# ─── 3. merge ─────────────────────────────────────────────────────
# rustc's own llvm-profdata (the matching LLVM) — /usr/bin/llvm-profdata
# is usually an older LLVM and rejects the raw profile version rustc 1.9x
# emits (raw v10 vs expected v9).
echo ""
echo "== merge profiles =="
LLVM_PD="$(ls "$(rustc --print sysroot)/lib/rustlib/"*/bin/llvm-profdata 2>/dev/null | head -1)"
if [ -z "$LLVM_PD" ]; then LLVM_PD="$(command -v llvm-profdata || true)"; fi
if [ -z "$LLVM_PD" ]; then
  echo "error: llvm-profdata not found (need the one matching rustc $(rustc --version | cut -d' ' -f2))" >&2
  exit 1
fi
"$LLVM_PD" merge -o "$PROF_DATA" "$PROF_DIR"/*.profraw
echo "   merged: $PROF_DATA ($(du -h "$PROF_DATA" | cut -f1))"

# ─── 4. PGO build ─────────────────────────────────────────────────
echo ""
echo "== build PGO CLI (RUSTFLAGS=-Cprofile-use) =="
( cd "$OTR" && RUSTFLAGS="-Cprofile-use=$PROF_DATA" cargo build --release )

# ─── 5. final benchmark + comparison ──────────────────────────────
echo ""
echo "== final benchmark (PGO CLI) =="
bench "$PGO_JSON"
python3 - "$BASE_JSON" "$PGO_JSON" <<'PY'
import json, sys
base = json.load(open(sys.argv[1]))
pgo = json.load(open(sys.argv[2]))
b, p = base["totalNativeMs"], pgo["totalNativeMs"]
print(f"  total native: baseline {b:.1f} ms → PGO {p:.1f} ms  ({(b - p) / b * 100:+.1f}%)")
print(f"  mimecroft.sh: baseline {base['files'][0]['nativeMs']:.1f} → PGO {pgo['files'][0]['nativeMs']:.1f} ms")
print("")
print("  per-file:")
for rb, rp in zip(base["files"], pgo["files"]):
    nb, np = rb["nativeMs"], rp["nativeMs"]
    print(f"    {rb['file'].split('/')[-1]:28} {nb:6.1f} → {np:6.1f} ms  ({(np - nb) / nb * 100:+.0f}%)")
PY
