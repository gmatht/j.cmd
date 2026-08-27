// ─── bench/gcc-vs-igpu/run.mjs — GCC C vs browser iGPU comparison ──
//
// 1. compiles the HANDWRITTEN C references (bench/gcc-vs-igpu/c-programs.mjs)
//    with gcc -O2;
// 2. calibrates each problem's size so the C run takes ~target seconds
//    (default 15 s, inside the "challenging but doable for GCC" 10-60 s band);
// 3. measures the C time (best of 2) and writes www/gcc-vs-igpu-results.json;
// 4. serves www/ and drives a REAL browser (headed = the system iGPU;
//    --headless = SwiftShader) to run the SAME problems at the SAME sizes
//    through the WebGL shader path (www/gcc-vs-igpu.html);
// 5. collects the page's comparison and prints the C-vs-iGPU table.
//
//   node bench/gcc-vs-igpu/run.mjs              # headed (real iGPU)
//   node bench/gcc-vs-igpu/run.mjs --headless   # SwiftShader (CI)
//   node bench/gcc-vs-igpu/run.mjs --quick      # 0.1x sizes (fast smoke)
//   node bench/gcc-vs-igpu/run.mjs --gpu-only   # GPU only, no C runs
//   node bench/gcc-vs-igpu/run.mjs --c-only     # C side only, print URL
// Exit 0 on all-pass (checksums match), 1 otherwise.
//
// Sizes are FIXED per problem (see BASE_N) so the C-vs-iGPU speedup is
// reproducible and not inflated at small N / deflated at large N. Both sides
// run at the same N; the per-item ns/item rates are the size-independent
// efficiency. Override a size via ?collatz=... in the page URL.
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright-core";
import { C_SOURCES } from "./c-programs.mjs";

const ROOT = new URL("../..", import.meta.url).pathname; // repo root (serve.py cwd)
const CHROME = process.env.CHROME_PATH ||
  "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const PORT = 8899;
const PAGE = `http://127.0.0.1:${PORT}/www/gcc-vs-igpu.html`;
const OUT_JSON = ROOT + "www/gcc-vs-igpu-results.json";

const args = process.argv.slice(2);
const headed = !args.includes("--headless");
const quick = args.includes("--quick");
const gpuOnly = args.includes("--gpu-only");
const cOnly = args.includes("--c-only");
const valOf = (flag, def) => {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return Number(args[i + 1]);
  const eq = args.find((a) => a.startsWith(flag + "="));
  return eq ? Number(eq.split("=")[1]) : def;
};
const BLOCK = valOf("--block", 1024);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. compile the handwritten C references ─────────────────────
const bins = {};
for (const [name, src] of Object.entries(C_SOURCES)) {
  writeFileSync(`/tmp/gvi_${name}.c`, src);
  execFileSync("gcc", [`/tmp/gvi_${name}.c`, "-o", `/tmp/gvi_${name}`, "-O2"], { stdio: "ignore" });
  bins[name] = `/tmp/gvi_${name}`;
}

// ── 2. run C at size N → {ms, checksum} ────────────────────────
function runC(name, N) {
  const t0 = performance.now();
  const out = execFileSync(bins[name], [String(N)], { stdio: "pipe" }).toString().trim();
  return { ms: performance.now() - t0, checksum: Number(out) >>> 0 };
}

// ── 3. fixed sizes (machine-independent) + per-item rates ──────
// N is FIXED per problem (NOT calibrated to a wall time) so the speedup is
// reproducible and not inflated at small N / deflated at large N. The C and
// GPU BOTH run at the SAME N; the per-item ns/item rates are the
// size-independent efficiency (the wall speedup equals C_ns/iGPU_ns because
// both use the same N). --quick scales N down 10x for a fast smoke test.
const BASE_N = { collatz: 100_000_000, ca1d: 1_000_000_000, hash: 1_000_000_000 };
const SCALE = quick ? 0.1 : 1;
function measure(name) {
  let N = Math.min(2 ** 31, Math.ceil((BASE_N[name] * SCALE) / BLOCK) * BLOCK);
  const r = runC(name, N);
  const r2 = runC(name, N); // best of 2
  const best = Math.min(r.ms, r2.ms);
  const nsPerItem = best * 1e6 / N;
  console.log(`  ${name}: N=${N} → C ${best.toFixed(0)} ms (${nsPerItem.toFixed(1)} ns/item, checksum ${r.checksum})`);
  return { name, size: N, cMs: best, cNsPerItem: nsPerItem, checksum: r.checksum };
}

// ── 3b. --gpu-only: fixed sizes, no C runs (quick GPU numbers) ──
const FIXED_SIZES = BASE_N;
let problems;
if (gpuOnly) {
  problems = ["collatz", "ca1d", "hash"].map((name) => ({ name, size: Math.ceil((BASE_N[name] * SCALE) / BLOCK) * BLOCK, cMs: null, checksum: null }));
  console.log(`== GCC C vs browser iGPU ==\n  --gpu-only: fixed sizes (collatz ${FIXED_SIZES.collatz}, ca1d ${FIXED_SIZES.ca1d}, hash ${FIXED_SIZES.hash}), no C runs`);
} else {
  console.log(`== GCC C vs browser iGPU ==\n  fixed sizes (collatz ${BASE_N.collatz}, ca1d ${BASE_N.ca1d}, hash ${BASE_N.hash})${quick ? " (--quick: 0.1x)\n" : "\n"}  measuring C…`);
  problems = ["collatz", "ca1d", "hash"].map(measure);
}
const cResults = { fixedN: BASE_N, scaled: SCALE, problems };
writeFileSync(OUT_JSON, JSON.stringify(cResults, null, 2));

// ── 3c. --c-only: stop after the C side, print the URL for a WINDOWS browser ──
// The real iGPU lives on the Windows side (WSLg's Linux GL falls back to
// SwiftShader). So: run the C side here (Linux gcc), then open the printed
// URL in a Windows browser (Edge/Chrome) — that browser has the real GPU.
if (cOnly) {
  const q = problems.map((x) => `${x.name}=${x.size}`).join("&") + `&block=${BLOCK}`;
  const serve = spawn("python3", ["www/serve.py", String(PORT)], { cwd: ROOT, stdio: "ignore" });
  await sleep(1200);
  console.log(`\n  C side done → www/gcc-vs-igpu-results.json written, server on http://localhost:${PORT}`);
  console.log(`  Open this URL in a WINDOWS browser (Edge/Chrome) to run the GPU side on the real iGPU:`);
  console.log(`    http://localhost:${PORT}/www/gcc-vs-igpu.html?${q}`);
  console.log(`  (WSL2 forwards localhost, so the Windows browser reaches the WSL server.)`);
  console.log(`  The page shows the C-vs-iGPU comparison when it finishes. Ctrl+C here when done.`);
  await new Promise(() => {}); // keep the server alive
}

// ── 4. serve + drive the browser (iGPU) ────────────────────────
const serve = spawn("python3", ["www/serve.py", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await sleep(1200);
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: !headed,
  args: headed
    ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-sandbox"]
    : ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-sandbox",
       "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader-webgl"],
});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const p = await ctx.newPage();
p.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 200)); });
p.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));

const q = problems.map((x) => `${x.name}=${x.size}`).join("&") + `&block=${BLOCK}`;
console.log(`  opening ${PAGE}?${q} (${headed ? "headed — system iGPU" : "headless — SwiftShader"}, block ${BLOCK})…`);
await p.goto(`${PAGE}?${q}`);
await p.waitForFunction(
  () => { const el = document.getElementById("out"); return !!el && el.textContent.includes("DONE"); },
  null, { timeout: quick ? 300000 : 900000 }
);
const pageResults = await p.evaluate(() => window.__gccVsIgpuResults);
await browser.close();
serve.kill();

// ── 5. the comparison table ────────────────────────────────────
console.log(`\n== comparison (${pageResults.renderer} · ${pageResults.hw}) ==`);
console.log("  " + "problem".padEnd(10) + "size".padEnd(14) + "C ms".padEnd(9) + "C ns/it".padEnd(10) + "iGPU ms".padEnd(9) + "iGPU ns/it".padEnd(12) + "speedup".padEnd(9) + "checksum");
let allOk = true;
for (const r of pageResults.problems) {
  if (r.err) { console.log("  " + r.name.padEnd(10) + "ERROR " + r.err); allOk = false; continue; }
  const cNsp = r.cMs ? (r.cMs * 1e6 / r.size).toFixed(1) : "—";
  const gNsp = (r.gpuMs * 1e6 / r.size).toFixed(2);
  const sp = r.cMs ? (r.cMs / r.gpuMs).toFixed(2) + "×" : "—";
  const ck = r.checksumOk === null ? "—" : r.checksumOk ? "✓" : "✗";
  if (r.checksumOk === false) allOk = false;
  console.log("  " + r.name.padEnd(10) + String(r.size).padEnd(14) + (r.cMs ? r.cMs.toFixed(0) : "—").padEnd(9) + cNsp.padEnd(10) + r.gpuMs.toFixed(1).padEnd(9) + gNsp.padEnd(12) + sp.padEnd(9) + ck);
}
writeFileSync(ROOT + "www/gcc-vs-igpu-comparison.json", JSON.stringify(pageResults, null, 2));
if (gpuOnly) {
  console.log("\n--gpu-only: no C side to compare — the numbers above are the GPU times only.");
} else {
  console.log("\n  speedup = C_ms / iGPU_ms = (C ns/it) / (iGPU ns/it) since both run at the same fixed N.");
  console.log(`\n${allOk ? "✅ ALL CHECKS PASS — every GPU checksum matches the C binary" : "❌ FAIL — a GPU checksum does not match the C binary"}`);
}
process.exit(allOk ? 0 : 1);
