#!/bin/bash
# ─── build-wasm-busybox.sh ─────────────────────────────────────
# Rebuild the unified transpiler frontend (busybox) for the web GUI.
#
# www/wasm-bin/otranspiler-busybox.wasm is the MERGED Go binary: all
# seven source frontends (posix-sh-go, go-sh, py-sh-go, c-sh-go,
# perl-sh-go, zsh-sh-go, fish-sh-go) + shir-emit-go + the dispatcher
# CLI, fused into ONE stdlib-only main.go and compiled with the real
# Go toolchain (GOOS=js GOARCH=wasm, src/go.js) — the same artifact
# the shell command would build on first use, but shipped prebuilt so
# www/otranspiler.html parses non-sh sources (zsh/fish/go/py/c/pl → A1
# shIR) with zero in-browser Go compile.
#
# Rebuild when the vendored frontends in www/bin/<frontend>/ change:
#   ./build-wasm-busybox.sh
# -----------------------------------------------------------------

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO"

node --input-type=module - <<'EOF'
import { fs } from "./src/fs/index.js";
import { GoRunner, createGoCommand } from "./src/go.js";
import { buildBusybox } from "./src/busybox.js";
import { writeFile } from "node:fs/promises";

const goRunner = new GoRunner(fs, { baseUrl: "www/" });
const goCmd = createGoCommand(
  goRunner,
  (s) => process.stdout.write(s),
  (s) => process.stderr.write(s),
);
const t0 = Date.now();
const wasmPath = await buildBusybox(fs, goRunner, goCmd, (m) => console.log("LOG: " + m));
const bytes = await fs.readBlob(wasmPath);
const buf = Buffer.from(await bytes.arrayBuffer());
await writeFile("www/wasm-bin/otranspiler-busybox.wasm", buf);
console.log(`==> www/wasm-bin/otranspiler-busybox.wasm (${(buf.length / 1024).toFixed(0)}K, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
EOF
