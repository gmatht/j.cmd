// ─── bench-transpile.mjs — transpile benchmark for the game + textures ──
// Measures the otranspilerl pipeline (bash → A1 shIR → ESTree JS) for
// www/bin/mimecroft.sh and its texture generators, through BOTH the
// browser wasm (the real runtime path: getOtranspilerl().transpile +
// .shir) and the native otranspilerl-cli (the PGO target).
//
//   node bench-transpile.mjs              — wasm pipeline, median of 3
//   node bench-transpile.mjs --native     — also the native CLI per file
//   node bench-transpile.mjs --runs=5     — change the iteration count
//   node bench-transpile.mjs --profile    — drive the CLI once per file
//                                          (feed an instrumented build's
//                                          PGO profraw); no timing loop
//   node bench-transpile.mjs --json       — machine-readable summary
//
// The wasm is the browser path (transpile + shir — bash2js calls both);
// the native CLI is the SAME Rust reactor (otranspilerl_cli), so its
// timings + the LLVM PGO profile map onto the wasm's hot code.
import { readFileSync, readdirSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { getOtranspilerl } from "./src/otranspilerl.js";

const ROOT = new URL(".", import.meta.url).pathname;
const MIMECROFT = ROOT + "www/bin/mimecroft.sh";
const TEX_DIR = ROOT + "www/examples/textures/";

// the game's own runtime workload: mimecroft.sh + every texture
// generator (texture-lib.sh is the shared lib the generators source —
// the transpiler sees it too) + the two helper scripts.
function collectFiles() {
  const files = [MIMECROFT];
  if (existsSync(TEX_DIR)) {
    const names = readdirSync(TEX_DIR).filter((n) => n.endsWith(".sh")).sort();
    for (const n of names) files.push(TEX_DIR + n);
  }
  return files;
}

const args = process.argv.slice(2);
const runs = Number((args.find((a) => a.startsWith("--runs=")) || "--runs=3").slice(7));
const wantNative = args.includes("--native");
const wantProfile = args.includes("--profile");
const wantJson = args.includes("--json");
const CLI = process.env.OTRANSPILERL_CLI || "/home/llm/sh2loop/otranspilerl/target/release/otranspilerl-cli";
const OTRANSPILER_ROOT = process.env.OTRANSPILER_ROOT || "/home/llm/sh2loop";

const files = collectFiles();
const results = [];

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

async function wasmPipeline(lib, src) {
  // the exact bash2js A1 path: the estree program + the A1 shIR
  const t0 = performance.now();
  const js = lib.transpile(src, "sh", "js");
  const t1 = performance.now();
  const a1 = lib.shir(src);
  const t2 = performance.now();
  return { jsLen: js.length, a1Len: a1.length, transpileMs: t1 - t0, shirMs: t2 - t1 };
}

function nativePipeline(file) {
  const t0 = performance.now();
  const out = execFileSync(CLI, ["--target=estree", file], {
    env: { ...process.env, OTRANSPILER_ROOT },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const t1 = performance.now();
  return { jsLen: out.length, ms: t1 - t0 };
}

// ─── warmup (module loads, wasm instantiation, first-parse jit) ───
const lib = await getOtranspilerl();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  wasmPipeline(lib, src);
}

if (wantProfile) {
  // single pass through the CLI — the instrumented build writes its
  // profraw on process exit; no timing, no repeats
  for (const f of files) {
    try { nativePipeline(f); } catch (e) { console.error("profile run failed:", f, e.message); process.exit(1); }
  }
  console.log(`profile workload done: ${files.length} files through ${CLI}`);
  process.exit(0);
}

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const wTimes = [];
  const nTimes = [];
  let last = null;
  for (let i = 0; i < runs; i++) {
    const w = await wasmPipeline(lib, src);
    wTimes.push(w);
    if (wantNative) {
      const n = nativePipeline(f);
      nTimes.push(n.ms);
      if (last && last.jsLen !== n.jsLen) console.error(`  !! native/wasm output mismatch on ${f} (${last.jsLen} vs ${n.jsLen})`);
    }
    last = w;
  }
  const w = wTimes[runs - 1];
  results.push({
    file: f.replace(ROOT, ""),
    bytes: src.length,
    wasmTranspileMs: median(wTimes.map((x) => x.transpileMs)),
    wasmShirMs: median(wTimes.map((x) => x.shirMs)),
    wasmMs: median(wTimes.map((x) => x.transpileMs + x.shirMs)),
    jsLen: w.jsLen,
    a1Len: w.a1Len,
    nativeMs: wantNative ? median(nTimes) : null,
  });
}

const total = results.reduce((a, r) => a + r.wasmMs, 0);
const totalNative = wantNative ? results.reduce((a, r) => a + (r.nativeMs || 0), 0) : null;
const game = results[0];

if (wantJson) {
  console.log(JSON.stringify({ runs, files: results, totalMs: total, totalNativeMs: totalNative }, null, 1));
  process.exit(0);
}

console.log(`\n== transpile benchmark (median of ${runs}, wasm pipeline: transpile + shir) ==`);
console.log(`   native CLI: ${CLI}${wantNative ? "" : " (add --native)"}`);
console.log("");
console.log("  file                                            bytes      js      a1    wasm ms  native ms");
for (const r of results) {
  const name = r.file.length > 50 ? "…" + r.file.slice(-49) : r.file;
  console.log(
    `  ${name.padEnd(50)} ${String(r.bytes).padStart(7)} ${String(r.jsLen).padStart(6)} ${String(r.a1Len).padStart(6)} ` +
    `${r.wasmMs.toFixed(1).padStart(7)}  ${r.nativeMs ? r.nativeMs.toFixed(1).padStart(7) : "—".padStart(7)}`
  );
}
console.log("");
console.log(`  TOTAL wasm: ${total.toFixed(1)} ms over ${results.length} files`);
if (totalNative !== null) console.log(`  TOTAL native: ${totalNative.toFixed(1)} ms`);
console.log(`  mimecroft.sh: ${game.wasmMs.toFixed(1)} ms (${(100 * game.wasmMs / total).toFixed(0)}% of the workload) — js ${game.jsLen} chars, a1 ${game.a1Len} chars`);
