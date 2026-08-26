// ─── __fuzzy-bench.mjs — the fuzzy-match GPU-lift benchmark ────
// The workload: score[x] = Σᵢ |needle[i] − haystack[i+x]| for every
// offset x (sliding-window / template matching). OFFSets are independent
// → embarrassingly parallel over x (one pixel per offset on the GPU).
//
// NODE measures the node-faithful HALF only (there is no GPU on node):
//   1. CPU baselines — fuzzy_bash.sh vs fuzzy_c.c wall time per case;
//   2. the GPU-path fixed overhead — the cold bash→GLSL compile (the
//      same wasm the browser runs) and the cached re-eval;
//   3. the LOAD TRANSFORM — the needle is chunked into pieces sized from
//      the integer precision and the data domain (CHUNK_SIZE =
//      floor(INT_MAX/MAXDIFF), capped by the backend's array cap), one
//      shader per chunk emits RGBA-packed partial scores, and the CPU
//      reduces. Node-verified: chunked reduce == C twin exactly; the
//      emitted pack bytes decode to the right scores; per-chunk score ≤
//      INT_MAX → the RGBA buffer can never overflow (src/fuzzygpu.js);
//   4. the crossover — where the GPU path's fixed cost beats the CPU.
// The actual GPU render + readBack throughput is BROWSER-only — open
// www/fuzzy-bench.html on a real GPU for that number.
//
//   node __fuzzy-bench.mjs            (min of 5 runs)
//   node __fuzzy-bench.mjs --quick    (1 run per case, CI)
//
// Exit 0; the shader must compile (0 unsupported) and the chunked
// reduce must equal the C twin (a correctness regression fails loudly).

import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { analyzeShader, getShaderTranslation, shaderCache } from "./src/shglsl-auto.js";
import {
  fuzzyChunkShaders, packChunkGLSL, reducePartials, cpuFuzzy, decodeRGBA,
  parsePackedBytes, evaluatePackedBytes, naiveBytes,
  chunkSizeFor, chunkBound, maxInputDiff,
  MEDIUM_INT_MAX, HIGH_INT_MAX, PACK_MAX, ARR_CAP,
} from "./src/fuzzygpu.js";
import { getOtranspilerl } from "./src/otranspilerl.js";

// ── the C twin (from the fuzzy design note) ──────────────────────
const FUZZY_C = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
int is_all_digits(const char *str){ if(!str||!*str) return 0; for(int i=0;str[i];i++) if(!isdigit((unsigned char)str[i])) return 0; return 1; }
int main(int argc, char *argv[]){
  if(argc!=3){ fprintf(stderr,"Usage: %s <needle> <haystack>\\n",argv[0]); return 1; }
  const char *n=argv[1], *h=argv[2];
  if(!is_all_digits(n)||!is_all_digits(h)){ fprintf(stderr,"digits only\\n"); return 1; }
  int nl=strlen(n), hl=strlen(h), mo=hl-nl;
  if(mo<0){ fprintf(stderr,"needle longer\\n"); return 1; }
  int best=-1, bo=-1;
  for(int x=0;x<=mo;x++){ int s=0; for(int i=0;i<nl;i++){ int d=n[i]-h[i+x]; if(d<0)d=-d; s+=d; } if(best==-1||s<best){ best=s; bo=x; } }
  printf("offset %d score %d\\n", bo, best);
  return 0;
}`;

// ── the bash twin (substring + arithmetic loops; slow for big input) ─
const FUZZY_BASH = `#!/bin/bash
needle="$1"; haystack="$2"
n_len=\${\#needle}; h_len=\${\#haystack}; max_offset=$((h_len - n_len))
best_score=-1; best_offset=-1
for (( x=0; x<=max_offset; x++ )); do
    score=0
    for (( i=0; i<n_len; i++ )); do
        n_char="\${needle:$i:1}"; h_char="\${haystack:$((i+x)):1}"
        diff=$(( n_char - h_char ))
        if [ "$diff" -lt 0 ]; then diff=$((-diff)); fi
        score=$(( score + diff ))
    done
    if [ "$best_score" -eq -1 ] || [ "$score" -lt "$best_score" ]; then best_score=$score; best_offset=$x; fi
done
echo "offset $best_offset score $best_score"
exit 0`;

// ── deterministic data (LCG, so every run compares like-for-like) ─
function digits(len, seed = 12345) {
  let s = seed;
  let out = "";
  for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) % 2147483648; out += String(s % 10); }
  return out;
}
const CASES = [
  { nl: 20,  hl: 200,   bash: true  },
  { nl: 100, hl: 2000,  bash: true  },
  { nl: 500, hl: 20000, bash: false }, // bash infeasible at this size
];

// per-offset fuzzy shader: full needle, ONE putb — the pack transform
// (shglsl-opt) widens it to the 4-byte RGBA result.
function fuzzyShader(nl, hl) {
  const needle = [...digits(nl)].map(Number);
  const hay = [...digits(hl)].map(Number);
  return [
    "x=$frag_x",
    "needle=(" + needle.join(" ") + ")",
    "haystack=(" + hay.join(" ") + ")",
    "n_len=" + nl,
    "score=0", "i=0",
    "while [ $i -lt $n_len ]; do",
    "    idx=$(( i + x ))",
    "    diff=$(( needle[i] - haystack[idx] ))",
    "    if [ $diff -lt 0 ]; then diff=$((-diff)); fi",
    "    score=$(( score + diff ))",
    "    i=$(( i + 1 ))",
    "done",
    "putb $(( score ))",
  ].join("\n");
}

const timeRun = (cmd, args, runs) => {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    execFileSync(cmd, args, { stdio: "ignore" });
    best = Math.min(best, (performance.now() - t0) * 1000);
  }
  return best / 1000; // ms
};

const runCTwin = (needle, hay) => {
  const out = execFileSync("/tmp/fuzzy_c", [needle, hay], { encoding: "utf8" });
  const m = /offset (-?\d+) score (-?\d+)/.exec(out);
  return { offset: Number(m[1]), score: Number(m[2]) };
};

// the chunk partials exactly as the shader computes them (the GPU
// simulation the reduce consumes — its only job is the Σ over the chunk)
function chunkPartials(needle, hay, chunks) {
  const offsets = hay.length - needle.length + 1;
  const partials = [];
  for (const ch of chunks) {
    const p = new Int32Array(offsets);
    for (let x = 0; x < offsets; x++) {
      let s = 0;
      for (let j = 0; j < ch.len; j++) s += Math.abs(needle[ch.start + j] - hay[ch.start + j + x]);
      p[x] = s;
    }
    partials.push(p);
  }
  return partials;
}

const quick = process.argv.includes("--quick");
const runs = quick ? 1 : 5;

// ── build C ──────────────────────────────────────────────────────
writeFileSync("/tmp/fuzzy_c.c", FUZZY_C);
execFileSync("cc", ["/tmp/fuzzy_c.c", "-o", "/tmp/fuzzy_c", "-O2"], { stdio: "ignore" });
writeFileSync("/tmp/fuzzy_bash.sh", FUZZY_BASH);

// ── 1. CPU baselines ─────────────────────────────────────────────
console.log("== CPU baselines (wall ms per case, min of " + runs + ") ==");
console.log("  " + "case (nl/hl)".padEnd(14) + "offsets".padEnd(10) + "bash".padEnd(10) + "C".padEnd(10) + "bash/C" + "   note");
for (const { nl, hl, bash } of CASES) {
  const needle = digits(nl), hay = digits(hl);
  const offsets = hl - nl + 1;
  const cMs = timeRun("/tmp/fuzzy_c", [needle, hay], runs);
  let bashMs = null, ratio = "";
  if (bash) {
    bashMs = timeRun("bash", ["/tmp/fuzzy_bash.sh", needle, hay], runs);
    ratio = (bashMs / cMs).toFixed(0) + "×";
  }
  console.log(
    `  ${(nl + "/" + hl).padEnd(14)}${String(offsets).padEnd(10)}` +
    `${(bashMs !== null ? bashMs.toFixed(1) : "—").padEnd(10)}${cMs.toFixed(3).padEnd(10)}${ratio.padEnd(6)}` +
    (bash ? "" : "bash infeasible — C only")
  );
}

// ── 2. GPU-path fixed overhead ───────────────────────────────────
// the valid worst case: hl=1024 is the backend's inline-array cap;
// anything larger writes past the declared [1024] array (OOB = UB) and
// needs the load transform / texture path, not a bigger literal.
const shader = fuzzyShader(100, 1024);
const a = await analyzeShader(shader);
console.log("\n== GPU-path fixed overhead (same wasm as the browser) ==");
console.log("  detector: shader=" + a.shader + " kind=" + a.kind + " worth=" + a.worth + " unsupported=" + a.report.fragment.total + " offsets(=pixels)=" + (1024 - 100 + 1) + " (hl=ARR_CAP " + ARR_CAP + ")");
await getShaderTranslation("putb 0");
shaderCache().clear();
let t0 = performance.now();
await getShaderTranslation(shader);
let t1 = performance.now();
const coldMs = t1 - t0;
t0 = performance.now();
for (let i = 0; i < 200; i++) await getShaderTranslation(shader);
t1 = performance.now();
const cachedMs = (t1 - t0) / 200;
console.log("  cold compile (bash→GLSL): " + coldMs.toFixed(2) + " ms · cached re-eval: " + cachedMs.toFixed(4) + " ms");

// ── 3. the LOAD TRANSFORM: chunk the needle, reduce on the CPU ────
console.log("\n== the load transform: chunk the needle, reduce on the CPU ==");
console.log("  (src/fuzzygpu.js — CHUNK_SIZE = floor(INT_MAX/MAXDIFF), capped by the array cap)");

// 3a. the chunk-size derivation + the overflow table
{
  const cMed = chunkSizeFor({});                             // digits, mediump
  const cHigh = chunkSizeFor({ intMax: HIGH_INT_MAX });      // digits, highp
  const cByte = chunkSizeFor({ maxDiff: 255 });              // 0..255 domain
  const cK = chunkSizeFor({ maxDiff: 999 });                 // 0..999 domain
  console.log("\n  3a. chunk size = floor(INT_MAX / MAXDIFF):");
  console.log("      digits (MAXDIFF=9):  mediump " + Math.floor(MEDIUM_INT_MAX / 9) + " → capped by ARR_CAP " + cMed + " · highp " + Math.floor(HIGH_INT_MAX / 9).toLocaleString("en-US") + " → " + cHigh);
  console.log("      byte domain (MAXDIFF=255): " + Math.floor(MEDIUM_INT_MAX / 255) + " → " + cByte);
  console.log("      millis  (MAXDIFF=999): " + Math.floor(MEDIUM_INT_MAX / 999) + " → " + cK);
  console.log("  per-pass partial ≤ CHUNK_SIZE·MAXDIFF ≤ INT_MAX — the RGBA pack (0…" + PACK_MAX.toLocaleString("en-US") + ") can't overflow:");
  console.log("    mediump int is ±2¹⁵ = 32767 on EVERY ES 1.00 device (highp needs OES_fragment_precision_high)");
  console.log("    single-pass full score would overflow the pack at nl ≥ " + (Math.floor((PACK_MAX - 1) / 9) + 1).toLocaleString("en-US") + " digits (and ARR_CAP " + ARR_CAP + " breaks it first)");
  console.log("    chunked: per-pass ≤ " + chunkBound(cMed) + " at C=" + cMed + " → headroom " + (PACK_MAX / chunkBound(cMed)).toFixed(0) + "×");
  console.log("    a future 1M-digit chunk at highp (9·10⁶ ≪ 2³¹−1) still packs — chunking is scale-agnostic");
}

// 3b. correctness: chunked reduce == exact reference == C twin
//   — digits at explicit sizes (multi-chunk), plus a GENERIC domain
//     case (values 0..255) where the chunk size is COMPUTED, not chosen
const CHUNK_CASES = [
  { nl: 320,  hl: 1000, max: 9,   chunk: 128,  note: "3 chunks, digits" },
  { nl: 500,  hl: 1000, max: 9,   chunk: 200,  note: "3 chunks, digits" },
  { nl: 960,  hl: 1024, max: 9,   chunk: 64,   note: "15 chunks, digits" },
];
const GEN_CASE = { nl: 300, hl: 1000, max: 255, chunk: null, note: "computed chunk, 0..255 domain" }; // 32767/255=128 → 4 chunks
console.log("\n  3b. correctness gate (chunked reduce == exact CPU reference == C twin)");
let allOk = true;
const checkChunked = (needle, hay, chunkSize, maxDiff) => {
  const { chunks } = fuzzyChunkShaders(needle, hay, { chunkSize, maxDiff });
  const ref = cpuFuzzy(needle, hay);
  const partials = chunkPartials(needle, hay, chunks);
  const { total, best, bestX } = reducePartials(partials, hay.length - needle.length + 1);
  const sameRef = best === ref.best && bestX === ref.bestX && total.every((v, i) => v === ref.scores[i]);
  const twin = maxDiff === 9 ? runCTwin(needle.join(""), hay.join("")) : null; // digits-only twin
  const sameC = twin !== null ? best === twin.score && bestX === twin.offset : null;
  const ok = sameRef && (sameC === null || sameC);
  if (!ok) allOk = false;
  return { m: chunks.length, cs: chunks[0]?.len ?? 0, bound: chunkBound(chunks[0]?.len ?? 0, maxDiff), best, bestX, sameRef, sameC, ok, twin };
};
for (const { nl, hl, max, chunk, note } of CHUNK_CASES) {
  const needle = [...digits(nl)].map(Number), hay = [...digits(hl)].map(Number);
  const r = checkChunked(needle, hay, chunk, max);
  console.log(
    `  ${String(nl + "/" + hl + " C=" + chunk).padEnd(20)} chunks=${String(r.m).padEnd(3)}` +
    ` bound=≤${r.bound} · best=${r.best}@${r.bestX}` +
    ` · ==cpuRef ${r.sameRef} · ==C-twin ${r.sameC} (${r.twin ? r.twin.offset + "/" + r.twin.score : "—"})  ${note}` + (r.ok ? "" : "  ← FAIL")
  );
}
{
  // the generic-domain case: chunk size COMPUTED (32767/255 = 128), no C twin
  const needle = [...digits(GEN_CASE.nl)].map(Number).map((v) => v * 25); // 0..225 ≤ 255
  const hay = [...digits(GEN_CASE.hl)].map(Number).map((v) => v * 25);
  const r = checkChunked(needle, hay, null, 255);
  console.log(
    `  ${String(GEN_CASE.nl + "/" + GEN_CASE.hl + " C=auto").padEnd(16)} chunks=${String(r.m).padStart(3)} (computed C=${r.cs})` +
    ` · bound=≤${r.bound} · best=${r.best}@${r.bestX} · ==cpuRef ${r.sameRef}` + `  ${GEN_CASE.note}` + (r.ok ? "" : "  ← FAIL")
  );
}

// 3c. pack-text verification: the EMITTED byte formulas decode exactly
console.log("\n  3c. pack transform: the emitted RGBA byte formulas decode exactly");
{
  const lib = await getOtranspilerl();
  const needle = [...digits(320)].map(Number), hay = [...digits(1000)].map(Number);
  const { chunks } = fuzzyChunkShaders(needle, hay, { chunkSize: 128 });
  for (const ch of chunks) {
    const raw = lib.raw("otranspilerl_glsl", [ch.src], [800]).output;
    const { glsl: packed, fired } = packChunkGLSL(raw);
    if (!fired) throw new Error("pack transform did not fire on chunk " + ch.c);
    const formulas = parsePackedBytes(packed);
    if (!formulas) throw new Error("no packed byte formulas in chunk " + ch.c);
    let ok = true, bad = "";
    for (const v of [0, 1, 127, 128, 255, 256, 65535, 65536, 9216, 123456789]) {
      const got = evaluatePackedBytes(formulas, v).join(",");
      const want = naiveBytes(v).join(",");
      if (got !== want) { ok = false; bad = `${v}: ${got} vs ${want}`; break; }
    }
    console.log(`  chunk ${ch.c} (${ch.len} digits): pack fired=${fired} · bytes decode ok=${ok}${ok ? "" : " ← " + bad}`);
    if (!ok) process.exit(1);
  }
}

// 3d. the pipeline price: m cold compiles (the chunk-count cost) + cached
{
  console.log("\n 3d. chunked pipeline cost (node-faithful half)");
  const lib = await getOtranspilerl();
  const needle = [...digits(500)].map(Number), hay = [...digits(1000)].map(Number);
  const { m, chunks } = fuzzyChunkShaders(needle, hay, { chunkSize: 200 });
  // the auto pipeline must see every chunk as a worth-it fragment shader
  const a0 = await analyzeShader(chunks[0].src, { lib });
  const aLast = await analyzeShader(chunks[m - 1].src, { lib });
  const det = a0.shader && a0.kind === "fragment" && a0.worth && a0.report.fragment.total === 0 &&
              aLast.shader && aLast.kind === "fragment" && aLast.worth && aLast.report.fragment.total === 0;
  console.log(`    detector: chunk 0 (${chunks[0].len} digits) & chunk ${m - 1} (${chunks[m - 1].len} digits):` +
    ` fragment+worth+0-unsupported=${det}`);
  if (!det) process.exit(1);
  shaderCache().clear();
  let t0 = performance.now();
  for (const ch of chunks) await getShaderTranslation(ch.src, { lib });
  let t1 = performance.now();
  const coldTotal = t1 - t0, coldPer = coldTotal / m;
  t0 = performance.now();
  for (let i = 0; i < 200; i++) await getShaderTranslation(chunks[0].src, { lib });
  t1 = performance.now();
  const cachedPer = (t1 - t0) / 200;
  console.log(`  nl=500 hl=1000 C=200: m=${m} chunks`);
  console.log(`    cold compile Σ${m}: ${coldTotal.toFixed(1)} ms (${coldPer.toFixed(1)} ms/chunk — the chunk-count price)`);
  console.log(`    cached re-eval per chunk: ${cachedPer.toFixed(4)} ms (the (a) reuse win)`);
  const bigM = Math.ceil(1000000 / ARR_CAP);
  console.log(`    extrapolated nl=1M, C=ARR_CAP=${ARR_CAP}: ${bigM} chunks × ${coldPer.toFixed(1)} ms ≈ ${((bigM * coldPer) / 1000).toFixed(1)} s cold`);
  console.log(`    → the chunk transform is exact and overflow-proof, but its price is one cold compile per`);
  console.log(`      chunk — the template-shader + texture-window path (compile once, load data per pass) is the follow-up.`);
}
if (!allOk) process.exit(1);

// ── 4. crossover estimate (the decision, node-faithful) ──────────
console.log("\n== crossover (where the GPU path pays) ==");
// GPU path ≈ compile (once) + render (browser, ~1ms est) — CPU path ≈ offsets × per-offset-CPU
const renderEstMs = 1.0;
for (const cMs of [CASES[0], CASES[1]]) {
  const { nl, hl, bash } = cMs;
  const needle = digits(nl), hay = digits(hl);
  const offsets = hl - nl + 1;
  const perOffsetC = timeRun("/tmp/fuzzy_c", [needle, hay], quick ? 1 : 5) / offsets;
  const bashTotal = bash ? timeRun("bash", ["/tmp/fuzzy_bash.sh", needle, hay], quick ? 1 : 5) : NaN;
  const perOffsetBash = bash ? bashTotal / offsets : NaN;
  console.log(
    `  ${nl}/${hl}: offsets=${offsets} · GPU-fixed=${(coldMs + renderEstMs).toFixed(0)}ms` +
    (bash ? ` · bash-total=${bashTotal.toFixed(0)}ms` : ` · bash: infeasible`) +
    ` · C-total=${(perOffsetC * offsets).toFixed(1)}ms` +
    (bash && bashTotal > coldMs + renderEstMs ? " → GPU already wins vs bash" : "")
  );
}
console.log("\nThe REAL GPU render+readBack number is browser-only: open www/fuzzy-bench.html on a GPU.");
