#!/usr/bin/env bash
# ─── fetch-wasm-cython.sh ───────────────────────────────────────
# Vendor the browser Cython runtime into www/vendor/:
#
#   • Pyodide 0.26.2 core — CPython 3.12 + stdlib compiled to wasm
#     (pyodide.js / pyodide.mjs / pyodide.asm.js / pyodide.asm.wasm /
#      python_stdlib.zip / pyodide-lock.json)  → www/vendor/pyodide/
#   • Cython 3.3.0 — the PURE-PYTHON wheel (py3-none-any); the compiler
#     zipimports straight from the .whl, no micropip, no PyPI at runtime
#                                                → www/vendor/cython-3.3.0-py3-none-any.whl
#
# www/vendor/cython-worker.js boots Pyodide (classic worker — Pyodide's
# loader needs importScripts) and compiles the generated .pyx/.py with the
# real Cython 3.3.0, offline. www/auto_cython.html wires the "Cythonize"
# button to it.
#
# Pinned versions; re-run to refresh.  Usage: ./fetch-wasm-cython.sh
# -----------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

PYODIDE_VERSION="0.26.2"
CYTHON_VERSION="3.3.0"
BASE="https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full"
DEST="www/vendor/pyodide"

mkdir -p "$DEST"
for f in pyodide.js pyodide.mjs pyodide.asm.js pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
  echo "  fetching ${f} (${PYODIDE_VERSION})…"
  curl -fsSL --retry 3 -o "${DEST}/${f}" "${BASE}/${f}"
done

echo "  fetching cython-${CYTHON_VERSION}-py3-none-any.whl…"
curl -fsSL --retry 3 -o "www/vendor/cython-${CYTHON_VERSION}-py3-none-any.whl" \
  "https://files.pythonhosted.org/packages/bf/77/67b0b24e45073a699610e50f00c18474ff9b09ea29ecc95083bdf5e60acd/cython-${CYTHON_VERSION}-py3-none-any.whl"

echo
echo "vendored:"
du -sh "$DEST" "www/vendor/cython-${CYTHON_VERSION}-py3-none-any.whl"
