#!/bin/bash
# ─── build-wasm-go.sh ───────────────────────────────────────────
# Build the REAL Go toolchain — cmd/compile (go.wasm) and cmd/link
# (link.wasm) — for GOOS=js GOARCH=wasm, exactly the target the user
# described: the produced binaries run in the browser through the Go
# distribution's wasm_exec.js glue (Go's os package maps to a JS "fs"
# object we back with the shell's VirtualFS, and net/http maps to the
# browser's fetch API).
#
# Pipeline:
#   1. Cross-compile cmd/compile and cmd/link to js/wasm
#      (the Go toolchain is pure Go, so it cross-compiles like any
#      other program: GOOS=js GOARCH=wasm go build cmd/compile)
#   2. Materialize a GOROOT for the js_wasm target from the build
#      cache: the compiled stdlib archives (.a) the compiler needs to
#      resolve imports. We ship the transitive closure of the popular
#      packages (fmt os strings strconv math time sort encoding/json)
#      plus net/http — which on js/wasm uses the browser fetch API.
#   3. Bundle the stdlib into ONE gzipped file (www/wasm-bin/goroot.dat)
#      so the browser shell downloads it in a single request, then
#      serves the .a files out of memory (Go's fs shim intercepts
#      /goroot/... paths).
#   4. Vendor wasm_exec.js (Go's js/wasm runtime glue) into www/vendor/.
#
# Usage:
#   ./build-wasm-go.sh
#   GOROOT_DIR=/path/to/goroot ./build-wasm-go.sh   # use a custom Go
# -----------------------------------------------------------------

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
GOBIN="$(command -v go || true)"
if [[ -z "$GOBIN" ]]; then
  echo "error: 'go' not found in PATH — install Go >= 1.21 (js/wasm target)" >&2
  exit 1
fi
echo "Using $(go version)"

PKGS="fmt os strings strconv math time sort encoding/json net/http"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. Cross-compile the toolchain
echo "== cmd/compile → go.wasm (GOOS=js GOARCH=wasm) =="
GOOS=js GOARCH=wasm go build -o "$WORK/go.wasm" cmd/compile
echo "== cmd/link → link.wasm =="
GOOS=js GOARCH=wasm go build -o "$WORK/link.wasm" cmd/link

# 2. Materialize the js_wasm stdlib from the build cache
echo "== Materializing js_wasm stdlib ($PKGS) =="
GOROOT_DIR="$WORK/goroot"
mkdir -p "$GOROOT_DIR/pkg/js_wasm"
GOOS=js GOARCH=wasm go list -export -deps -f '{{.ImportPath}} {{.Export}}' $PKGS \
  > "$WORK/closure.list"
ARCHIVES=0
while read -r imp path; do
  if [[ -n "$path" ]]; then
    mkdir -p "$(dirname "$GOROOT_DIR/pkg/js_wasm/$imp")"
    cp "$path" "$GOROOT_DIR/pkg/js_wasm/$imp.a"
    ARCHIVES=$((ARCHIVES + 1))
  fi
done < "$WORK/closure.list"
cp "$(go env GOROOT)/VERSION" "$GOROOT_DIR/VERSION"
echo "  $ARCHIVES archives"

# 3. Bundle the goroot into one gzipped file:
#    [4B magic "GOR1"][4B headerLen LE][header JSON (path,off,len)][data]
echo "== Bundling goroot → goroot.dat =="
node - "$GOROOT_DIR" "$WORK" <<'EOF'
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const [srcDir, workDir] = process.argv.slice(2);

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push({ rel: path.relative(srcDir, p).replace(/\\/g, "/"), buf: fs.readFileSync(p) });
  }
};
walk(srcDir);

const index = [];
const chunks = [];
let off = 0;
for (const f of files.sort((a, b) => a.rel < b.rel ? -1 : 1)) {
  index.push([f.rel, off, f.buf.length]);
  chunks.push(f.buf);
  off += f.buf.length;
}
const header = Buffer.from(JSON.stringify(index), "utf8");
const data = Buffer.concat(chunks);
const magic = Buffer.from("GOR1");
const headerLen = Buffer.alloc(4);
headerLen.writeUInt32LE(header.length, 0);
const out = zlib.gzipSync(Buffer.concat([magic, headerLen, header, data]));
fs.writeFileSync(path.join(workDir, "goroot.dat"), out);
console.log(`  ${files.length} files, ${(data.length / 1048576).toFixed(1)}MB raw → ${(out.length / 1048576).toFixed(1)}MB gzipped`);
EOF

# 4. Vendor wasm_exec.js
echo "== Vendoring wasm_exec.js =="
cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" "$WORK/wasm_exec.js"

# 5. Install into the shell
DEST="$REPO/www/wasm-bin"
mkdir -p "$DEST"
cp "$WORK/go.wasm" "$DEST/go.wasm"
cp "$WORK/link.wasm" "$DEST/link.wasm"
cp "$WORK/goroot.dat" "$DEST/goroot.dat"
cp "$WORK/wasm_exec.js" "$REPO/www/vendor/wasm_exec.js"

echo ""
echo "✓ Installed:"
echo "  www/wasm-bin/go.wasm     ($(du -h "$DEST/go.wasm" | cut -f1)) — the Go compiler (cmd/compile), js/wasm"
echo "  www/wasm-bin/link.wasm   ($(du -h "$DEST/link.wasm" | cut -f1)) — the Go linker (cmd/link), js/wasm"
echo "  www/wasm-bin/goroot.dat  ($(du -h "$DEST/goroot.dat" | cut -f1)) — js_wasm stdlib bundle (gzip)"
echo "  www/vendor/wasm_exec.js  — Go's js/wasm runtime glue"
echo "  In the shell:  go run main.go   (compiles with the REAL Go compiler, in the browser)"
