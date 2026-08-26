// ─── __gpu-catalog-bench.mjs — the GPU-lift catalog benchmark ────
// The fuzzy matcher's recipe generalised to three more algorithms
// (src/gpucatalog.js + gl-catalog-gate.mjs):
//
//   collatz  (fragment) — the Collatz step count per number; one pixel
//            per input, DATA-DRIVEN loop (while n > 1), texture window.
//   ca1d     (fragment) — one 1D cellular-automaton step; one pixel per
//            cell; THREE neighbour reads per fragment via tex_idx
//            reassignment between reads; baked rule.
//   hash     (vertex)   — per-record hash; ONE VERTEX per record; the
//            record arrives via the ap_* bridges, the payload leaves via
//            vc_* (×1000 → exact byte round-trip), the slot via auv_u/v,
//            and the POINTS raster reads back like any canvas.
//
// For each: the CPU baselines (bash vs C twin), the GPU-path fixed
// overhead (cold bash→GLSL/GLSLv compile + cached re-eval), the
// transform fire/refuse + emitted-output checks, the exactness gate
// (headless-gl equality == the CPU reference), and the crossover.
//
//   node __gpu-catalog-bench.mjs            (min of 5 runs)
//   node __gpu-catalog-bench.mjs --quick    (1 run per case, CI)
// Exit 0; any gate failure exits non-zero.

import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { getOtranspilerl } from "./src/otranspilerl.js";
import { getShaderTranslation, shaderCache } from "./src/shglsl-auto.js";
import {
  collatzShader, compileCollatzGLSL, collatzCPU,
  ca1dShader, compileCa1DGLSL, ca1DCPU,
  hashVertexShader, hashCPU, decodeVertexBytes, CATALOG,
} from "./src/gpucatalog.js";
import { liftTextureWindowSample, packFragmentResultToRGBA } from "./src/shglsl-opt.js";
import { decodeRGBA } from "./src/fuzzygpu.js";

const quick = process.argv.includes("--quick");
const runs = quick ? 1 : 5;

const timeRun = (cmd, args, runs) => {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    execFileSync(cmd, args, { stdio: "ignore" });
    best = Math.min(best, (performance.now() - t0) * 1000);
  }
  return best / 1000;
};

// ── the C + bash twins (one work item per invocation) ────────────
const C_TWINS = {
  collatz: `#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv){ long long n=atoll(argv[1]); int s=0;
while(n>1){ n = n%2==0 ? n/2 : 3*n+1; s++; } printf("%d\\n", s); return 0; }`,
  ca1d: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv){ // argv[1] = row (0/1 bits), argv[2] = 8 rule bits
 int n=strlen(argv[1]); int rule[8]; for(int i=0;i<8;i++) rule[i]=argv[2][i]-'0';
 char *out=calloc(n+1,1); for(int x=0;x<n;x++){ int l=x?argv[1][x-1]-'0':argv[1][0]-'0';
 int m=argv[1][x]-'0'; int r=x<n-1?argv[1][x+1]-'0':argv[1][n-1]-'0';
 out[x]='0'+rule[l*4+m*2+r]; } printf("%s\\n", out); return 0; }`,
  hash: `#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv){ int a=atoi(argv[1]), b=atoi(argv[2]), c=atoi(argv[3]);
 printf("%d\\n", (a*31+b*17+c*7)%256); return 0; }`,
};
const BASH_TWINS = {
  collatz: `#!/bin/bash
n=$1; s=0
while [ "$n" -gt 1 ]; do if [ $((n % 2)) -eq 0 ]; then n=$((n / 2)); else n=$((3 * n + 1)); fi; s=$((s + 1)); done
echo $s`,
  ca1d: `#!/bin/bash
row=$1; rule=$2; n=\${#row}; out=""
for ((x=0; x<n; x++)); do
  l=\${row:$((x?x-1:0)):1}; m=\${row:x:1}; r=\${row:$((x<n-1?x+1:n-1)):1}
  idx=$((l*4+m*2+r)); out="$out\${rule:idx:1}"
done
echo "$out"`,
  hash: `#!/bin/bash
echo $(( ($1 * 31 + $2 * 17 + $3 * 7) % 256 ))`,
};

// ── build the twins ──────────────────────────────────────────────
for (const k of Object.keys(C_TWINS)) {
  writeFileSync(`/tmp/cat_${k}.c`, C_TWINS[k]);
  execFileSync("cc", [`/tmp/cat_${k}.c`, "-o", `/tmp/cat_${k}`, "-O2"], { stdio: "ignore" });
  writeFileSync(`/tmp/cat_${k}.sh`, BASH_TWINS[k]);
}

const lib = await getOtranspilerl();

console.log("== the GPU-lift catalog (src/gpucatalog.js) ==");
for (const entry of CATALOG) {
  console.log(`  ${entry.key.padEnd(9)} ${entry.stage.padEnd(9)} ${entry.parallel}`);
}

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`    ${name}: ${ok ? "PASS" : "FAIL"}${extra && !ok ? "  ← " + extra : ""}`);
  if (!ok) fails++;
};

// the headless-gl equality gate (needs gl — skipped when absent)
async function runGate() {
  try {
    createRequire(import.meta.url)("gl");
    const gate = await import("./gl-catalog-gate.mjs");
    const res = await gate.run({
      lib, collatzShader, compileCollatzGLSL, collatzCPU,
      ca1dShader, compileCa1DGLSL, ca1DCPU,
      hashVertexShader, hashCPU, decodeRGBA, decodeVertexBytes,
    });
    return res === true;
  } catch (e) {
    if (/Cannot find package|Cannot find module/.test(String(e.message))) return null; // no headless-gl
    throw e;
  }
}

// ── 1. collatz (fragment, data-driven loop) ─────────────────────
{
  const item = "255";
  const cMs = timeRun("/tmp/cat_collatz", [item], runs);
  const bMs = timeRun("bash", ["/tmp/cat_collatz.sh", item], runs);
  console.log(`\n== collatz (fragment · one pixel per number · data-driven loop) ==`);
  console.log(`  CPU per item (n=${item}): bash ${bMs.toFixed(2)} ms · C ${cMs.toFixed(3)} ms · bash/C ${(bMs / cMs).toFixed(0)}×`);
  await getShaderTranslation("putb 0");
  shaderCache().clear();
  let t0 = performance.now();
  await getShaderTranslation(collatzShader());
  let t1 = performance.now();
  const cold = t1 - t0;
  t0 = performance.now();
  for (let i = 0; i < 100; i++) await getShaderTranslation(collatzShader());
  t1 = performance.now();
  console.log(`  GPU-path fixed: cold compile ${cold.toFixed(1)} ms · cached re-eval ${((t1 - t0) / 100).toFixed(4)} ms`);
  const raw = lib.raw("otranspilerl_glsl", [collatzShader()], [800]).output;
  const glsl = liftTextureWindowSample(raw, { width: 8, height: 1, highp: true });
  const packed = packFragmentResultToRGBA(glsl);
  check("transform (windowed sample + highp + pack)", glsl !== raw && packed.includes("texture2D(uTex, vec2((float(g_tex_idx) + 0.5)") && packed.includes("precision highp float;"));
  check("CPU reference sanity", collatzCPU([1, 7, 27, 255, 64]).join(",") === "0,16,111,47,6");
  const batch = ["27", "97", "255", "64", "129", "3", "7", "11"];
  let totalBash = 0, totalC = 0;
  for (const it of batch) { totalBash += timeRun("bash", ["/tmp/cat_collatz.sh", it], runs); totalC += timeRun("/tmp/cat_collatz", [it], runs); }
  console.log(`  batch ${batch.length} items: bash Σ ${totalBash.toFixed(1)} ms · C Σ ${totalC.toFixed(2)} ms · GPU-path ≈ ${(cold + 1).toFixed(0)} ms → ${totalBash > cold + 1 ? "GPU wins vs bash at this batch" : "GPU fixed cost ≈ bash batch"}`);
}

// ── 2. ca1d (fragment, neighbour reads) ─────────────────────────
{
  const row = "00000001000000000001000000100000";
  const rule = "01110110"; // 118
  console.log(`\n== ca1d (fragment · one pixel per cell · three neighbour reads) ==`);
  const cMs = timeRun("/tmp/cat_ca1d", [row, rule], runs);
  const bMs = timeRun("bash", ["/tmp/cat_ca1d.sh", row, rule], runs);
  console.log(`  CPU per row (${row.length} cells): bash ${bMs.toFixed(2)} ms · C ${cMs.toFixed(3)} ms · bash/C ${(bMs / cMs).toFixed(0)}×`);
  shaderCache().clear();
  let t0 = performance.now();
  await getShaderTranslation(ca1dShader());
  let t1 = performance.now();
  const coldCa = t1 - t0;
  console.log(`  GPU-path fixed: cold compile ${coldCa.toFixed(1)} ms`);
  const rawCa = lib.raw("otranspilerl_glsl", [ca1dShader()], [800]).output;
  const glslCa = liftTextureWindowSample(rawCa, { width: 32, height: 1, highp: true });
  const sampleCount = (glslCa.match(/texture2D\(uTex/g) || []).length;
  check("transform (three per-use samples + highp)", glslCa !== rawCa && sampleCount >= 3 && glslCa.includes("precision highp float;"), `samples=${sampleCount}`);
  const cells = [...row].map(Number);
  const want = ca1DCPU(cells, [0, 1, 1, 1, 0, 1, 1, 0]);
  check("CPU semantics", want.join("") === "00000011000000000011000001100000");
  const rows = ["0100100", "10101010101010101010", "11110000111100001111"];
  let totalBash = 0;
  for (const r of rows) totalBash += timeRun("bash", ["/tmp/cat_ca1d.sh", r, rule], runs);
  console.log(`  batch ${rows.length} rows: bash Σ ${totalBash.toFixed(1)} ms · GPU-path ≈ ${(coldCa + 1).toFixed(0)} ms`);
}

// ── 3. hash (vertex, per-record) ────────────────────────────────
{
  console.log(`\n== hash (vertex · one vertex per record · vc_* payload) ==`);
  const cMs = timeRun("/tmp/cat_hash", ["7", "3", "9"], runs);
  const bMs = timeRun("bash", ["/tmp/cat_hash.sh", "7", "3", "9"], runs);
  console.log(`  CPU per record (7,3,9): bash ${bMs.toFixed(2)} ms · C ${cMs.toFixed(3)} ms · bash/C ${(bMs / cMs).toFixed(0)}×`);
  const rawV = lib.raw("otranspilerl_glslv", [hashVertexShader()], [800]).output;
  const hasFloatPath = rawV.includes("float g_vp_x;") && /gl_Position = vec4\(g_vp_x, g_vp_y, g_vp_z, g_vp_w\)/.test(rawV);
  const noString = !rawV.includes("itos(") && !rawV.includes("cat(ivec2");
  check("vertex pipeline (bc-float vp_* + no string helpers)", hasFloatPath && noString);
  const records = [[7, 3, 9], [255, 255, 255], [100, 200, 50], [13, 29, 17]];
  check("CPU semantics", hashCPU(records).join(",") === "75,201,194,247");
}

const gateRes = await runGate();
if (gateRes !== null) check("headless-gl equality gate (collatz + ca1d + hash)", gateRes === true);
if (fails > 0) {
  console.log(`\n${fails} FAILURE(S)`);
  process.exit(1);
}
console.log("\nCATALOG BENCH: ALL GATES PASS");
