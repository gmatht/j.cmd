// ─── fuzzygpu.js — the fuzzy-match GPU load + optimise transforms ──
//
// The workload: score[x] = Σᵢ |needle[i] − haystack[i+x]| for every
// offset x. On the GPU the offset dimension is pixels (one fragment per
// x, the whole needle loop per fragment) and each pixel's result has to
// round-trip through the RGBA byte buffer (out_buf[4] → gl_FragColor →
// readPixels). The score is therefore bounded by MAXDIFF×needle-len,
// which overflows the accumulator (and then the RGBA pack) once the
// needle gets long — and the backend's inline-array cap (ARR_CAP 1024)
// breaks the needle itself first.
//
// This module is the transform that makes the fuzzy search load and
// stay exact at scale:
//
//   • CHUNK the needle into pieces sized from the INTEGER PRECISION and
//     the DATA DOMAIN, not a hardcoded constant:
//
//         CHUNK_SIZE = floor(INT_MAX / MAXDIFF)
//
//     where INT_MAX is the shader accumulator's safe range (mediump int
//     ±2¹⁵ = 32767 is the ES 1.00 minimum every device guarantees; highp
//     int32 widens it ~65k× but needs OES_fragment_precision_high on
//     mobile) and MAXDIFF = max |a−b| over the input domain (digits
//     0..9 → 9). The bound is then structural: CHUNK_SIZE is additionally
//     capped by the backend's inline-array cap ARR_CAP.
//
//     The per-pass guarantee:
//         partial_c[x] = Σ_{i∈chunk} |needle[i] − haystack[i+x]|
//                       ≤ CHUNK_SIZE·MAXDIFF ≤ INT_MAX   (accumulator)
//                       ≤ INT_MAX ≤ 2³¹−1               (RGBA pack)
//     → the RGBA buffer can never overflow: no sentinel, no wrap.
//     Headroom at mediump: 2³¹−1/32767 ≈ 65,535× (a 1M-digit chunk at
//     highp int32: 9·10⁶ ≪ 2³¹−1 — still packs).
//
//   • one shader pass per chunk (each embeds the chunk + the FULL
//     haystack — every chunk needs haystack[start..start+len+offsets),
//     which is the whole thing), each emitting the partial score;
//   • PACK each partial into the 32-bit RGBA buffer (the shglsl-opt
//     packFragmentResultToRGBA rewrite: 4 exact ES 1.00 byte writes +
//     the A≥128 sentinel for anything unrepresentable);
//   • REDUCE on the CPU — total[x] = Σ_c partial_c[x] in JS numbers
//     (exact to 2⁵³), then the argmin.
//
// For the haystack (the other half of the data): when hl > ARR_CAP the
// inline array can't hold it, so the haystack moves to an uploaded W×H
// texture read through the tex_* bridge at a program-set tex_idx — the
// texture-window transport (fuzzyTextureChunkShaders + the
// liftTextureWindowSample pass, see §2 and shglsl-opt.js).
// Everything here is node-faithful: the generator + reduce + the pack
// text are verified against the C twin by __fuzzy-bench.mjs, and the
// browser harness (www/fuzzy-bench.html) runs the same generator.

import { packFragmentResultToRGBA, liftTextureWindowSample, tileOffsetUniform, needleLengthUniform, chunkStartUniform } from "./shglsl-opt.js";

// ── the representability bounds the chunk size is computed from ───
export const MEDIUM_INT_MAX = 32767;    // ES 1.00 mediump int minimum (±2¹⁵) — the SAFE accumulator bound on every device
export const HIGH_INT_MAX = 0x7fffffff; // highp int32 — also the RGBA pack's exact range
export const PACK_MAX = HIGH_INT_MAX;   // the 32-bit RGBA pack's exact range (A ≤ 127 = valid sentinel-free)
export const ARR_CAP = 1024;            // the backend's inline-array element cap (structural, §5 of the shader doc)
export const MAX_DIFF = 9;              // default |a−b| bound for digit (0..9) data

// max |a−b| over the input domain. For non-negative data (digits 0..9)
// it is the largest value present; callers with signed data can pass
// maxDiff explicitly (|a−b| ≤ |a|+|b| then).
export function maxInputDiff(needle, haystack, explicit = null) {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  let m = 0;
  for (const v of needle) if (v > m) m = v;
  for (const v of haystack) if (v > m) m = v;
  return Math.max(1, m); // even an all-zero input has a nonzero bound (diff ≥ 0 anyway)
}

// ── the chunk size: computed from the int precision + the data ────
//   CHUNK_SIZE = floor(INT_MAX / MAXDIFF), capped by the inline-array
//   cap (a chunk must still embed). Pass {intMax: HIGH_INT_MAX} for the
//   highp path (2³¹−1/9 ≈ 238M-digit chunks) or {maxDiff: V} for a
//   different data domain.
export function chunkSizeFor({ intMax = MEDIUM_INT_MAX, maxDiff = MAX_DIFF, arrCap = ARR_CAP } = {}) {
  if (!Number.isInteger(intMax) || intMax <= 0) throw new Error("chunkSizeFor: intMax must be a positive int");
  if (!Number.isInteger(maxDiff) || maxDiff <= 0) throw new Error("chunkSizeFor: maxDiff must be a positive int");
  const byInt = Math.floor(intMax / maxDiff);
  return Math.max(1, Math.min(byInt, arrCap));
}

// the per-chunk score bound given a chunk size and the data max-diff
export function chunkBound(chunkSize, maxDiff = MAX_DIFF) {
  return chunkSize * maxDiff;
}

// ── 1. the chunk generator (the LOAD transform) ──────────────────────────
// needle/haystack are value arrays (digits 0..9, or any non-negative
// integers whose |a−b| ≤ maxDiff). chunkSize defaults to the COMPUTED
// mediump-safe size (clamped by ARR_CAP); returns self-contained shader
// sources, one per chunk, each embedding the chunk + the FULL haystack
// and outputting the chunk's partial score (single putb → the pack
// transform fires).
export function fuzzyChunkShaders(needle, haystack, opts = {}) {
  const nl = needle.length, hl = haystack.length;
  const maxDiff = maxInputDiff(needle, haystack, opts.maxDiff ?? null);
  const chunkSize = opts.chunkSize ?? chunkSizeFor({ intMax: opts.intMax ?? MEDIUM_INT_MAX, maxDiff, arrCap: opts.arrCap ?? ARR_CAP });
  if (chunkSize > ARR_CAP && !opts.allowOverCap) {
    throw new Error(
      `fuzzyChunkShaders: chunkSize ${chunkSize} > ARR_CAP ${ARR_CAP} — the chunk must inline ` +
      `(backend cap); computed from intMax/MAXDIFF = ${chunkSize} — cap it or pass allowOverCap`
    );
  }
  if (hl > ARR_CAP) {
    throw new Error(
      `fuzzyChunkShaders: haystack ${hl} > ARR_CAP ${ARR_CAP} — use fuzzyTextureChunkShaders ` +
      `(the haystack loads as an uploaded texture, §6f)`
    );
  }
  const m = Math.max(1, Math.ceil(nl / chunkSize));
  const chunks = [];
  for (let c = 0; c < m; c++) {
    const start = c * chunkSize;
    const len = Math.min(chunkSize, nl - start);
    chunks.push({ c, start, len, src: chunkSrc(needle, haystack, start, len) });
  }
  return { nl, hl, m, chunkSize, maxDiff, chunks };
}

function chunkSrc(needle, haystack, start, len) {
  const chunk = needle.slice(start, start + len);
  return [
    "x=$frag_x",
    "needle=(" + chunk.join(" ") + ")",
    "haystack=(" + haystack.join(" ") + ")",
    "chunk_len=" + len,
    "chunk_start=" + start,
    "score=0",
    "i=0",
    "while [ $i -lt $chunk_len ]; do",
    "    idx=$(( chunk_start + i + x ))",
    "    diff=$(( needle[i] - haystack[idx] ))",
    "    if [ $diff -lt 0 ]; then diff=$((-diff)); fi",
    "    score=$(( score + diff ))",
    "    i=$(( i + 1 ))",
    "done",
    "putb $(( score ))",
  ].join("\n");
}

// ── 2. the TEXTURE-WINDOW variant: the haystack lives in a texture ─
// The inline haystack is capped at ARR_CAP — for hl > 1024 the haystack
// moves to an uploaded W×H texture and the shader reads it through
// `tex_r` at a program-set `tex_idx` (per-iteration: tex_idx =
// chunk_start + i + x). The backend emits NO sample for loop reads, so
// liftTextureWindowSample rewrites every tex read into a per-use sample
// at that index (see shglsl-opt.js). The needle stays inline (chunked).
export function fuzzyTextureChunkShaders(needle, haystack, opts = {}) {
  const nl = needle.length, hl = haystack.length;
  const maxDiff = maxInputDiff(needle, haystack, opts.maxDiff ?? null);
  const chunkSize = opts.chunkSize ?? chunkSizeFor({ intMax: opts.intMax ?? MEDIUM_INT_MAX, maxDiff, arrCap: opts.arrCap ?? ARR_CAP });
  if (chunkSize > ARR_CAP && !opts.allowOverCap) {
    throw new Error(`fuzzyTextureChunkShaders: chunkSize ${chunkSize} > ARR_CAP ${ARR_CAP} — the needle chunk must inline`);
  }
  const m = Math.max(1, Math.ceil(nl / chunkSize));
  const chunks = [];
  for (let c = 0; c < m; c++) {
    const start = c * chunkSize;
    const len = Math.min(chunkSize, nl - start);
    chunks.push({ c, start, len, src: textureChunkSrc(needle, start, len) });
  }
  return { nl, hl, m, chunkSize, maxDiff, chunks, texture: true };
}

function textureChunkSrc(needle, start, len) {
  const chunk = needle.slice(start, start + len);
  return [
    "x=$frag_x",
    "needle=(" + chunk.join(" ") + ")",
    "chunk_len=" + len,
    "chunk_start=" + start,
    "score=0",
    "i=0",
    "while [ $i -lt $chunk_len ]; do",
    "    tex_idx=$(( chunk_start + i + x ))",
    "    diff=$(( needle[i] - tex_r ))",
    "    if [ $diff -lt 0 ]; then diff=$((-diff)); fi",
    "    score=$(( score + diff ))",
    "    i=$(( i + 1 ))",
    "done",
    "putb $(( score ))",
  ].join("\n");
}

// the haystack → RGBA texel bytes for a W×H layout (digit in R, the
// texel A=255 so the A≥128 sentinel check stays meaningful); height is
// the smallest row count that holds hl digits.
export function haystackTexelData(haystack, width = 4096) {
  const hl = haystack.length;
  const h = Math.max(1, Math.ceil(hl / width));
  const data = new Uint8Array(width * h * 4);
  for (let i = 0; i < hl; i++) {
    data[i * 4] = haystack[i]; // digit 0..9 in the R byte
    data[i * 4 + 3] = 255;
  }
  return { width, height: h, data };
}

// the texture-mode GLSL pipeline for one chunk: raw render → the
// windowed-sample lift → (optional) the offset-axis tile uniform → the
// RGBA pack. Returns {glsl, fired} (fired = any transform changed the
// shader). With tile: true the SAME compiled shader runs every offset
// tile (uTileStart varies at bind time, not compile time).
export function packTextureChunkGLSL(rawGlsl, { width = 4096, height = 1, tile = false } = {}) {
  let g = liftTextureWindowSample(rawGlsl, { width, height, highp: true });
  if (tile) g = tileOffsetUniform(g);
  const fired = g !== String(rawGlsl);
  return { glsl: packFragmentResultToRGBA(g), fired };
}

// the offset-axis tiling: offsets pixels split into ≤ tileW-wide tiles
// (the canvas cap). Each tile renders tileW pixels at a global offset
// t·tileW; the uTileStart uniform shifts the frag_x bridge.
export function tileLayout(offsets, tileW) {
  const n = Math.max(1, Math.ceil(offsets / tileW));
  const tiles = [];
  for (let t = 0; t < n; t++) {
    const start = t * tileW;
    tiles.push({ t, start, w: Math.min(tileW, offsets - start) });
  }
  return { n, tiles };
}

// ── 2b. the compile-once TEMPLATE: the needle moves into uCrack ──
// The remaining price of the chunk path is one cold compile per chunk
// (the needle digits inline → each chunk is a distinct source). This
// template moves the needle into the SECOND sampler (uCrack via the
// cr_* bridge — the same window lift as the haystack) and the per-chunk
// constants (needle_len, chunk_start) into uniforms (needleLengthUniform),
// so ONE compiled shader runs every chunk: the data — needle texture,
// uNeedleLen, uNeedleStart — varies at bind time, not compile time.
// The source is data-independent (no needle digits at all).
export function fuzzyTemplateShader() {
  return [
    "x=$frag_x",
    "needle_len=0",   // → uNeedleLen  (needleLengthUniform)
    "chunk_start=0",  // → uNeedleStart (needleLengthUniform)
    "score=0",
    "i=0",
    "while [ $i -lt $needle_len ]; do",
    "    tex_idx=$(( chunk_start + i + x ))",   // haystack window (uTex)
    "    crack_idx=$(( chunk_start + i ))",     // needle window (uCrack)
    "    diff=$(( cr_r - tex_r ))",
    "    if [ $diff -lt 0 ]; then diff=$((-diff)); fi",
    "    score=$(( score + diff ))",
    "    i=$(( i + 1 ))",
    "done",
    "putb $(( score ))",
  ].join("\n");
}

// the needle → RGBA texel bytes (the uCrack texture; digits in R, like
// the haystack texture). Holds the FULL needle — chunks are uniform
// windows (uNeedleStart/uNeedleLen) into it, no per-chunk upload.
export function needleTexelData(needle, width = 4096) {
  const nl = needle.length;
  const h = Math.max(1, Math.ceil(nl / width));
  const data = new Uint8Array(width * h * 4);
  for (let i = 0; i < nl; i++) {
    data[i * 4] = needle[i];
    data[i * 4 + 3] = 255;
  }
  return { width, height: h, data };
}

// the template GLSL pipeline: raw render → the tex+crack window lift →
// the needle-length/start uniforms → (optional) the tile uniform → the
// RGBA pack. Returns {glsl, fired}. Compile ONCE; run per chunk by
// binding uNeedleLen/uNeedleStart (+ uTileStart when tiled).
export function compileTemplateGLSL(rawGlsl, opts = {}) {
  const {
    width = 4096, height = 1,        // haystack (uTex) layout
    crackWidth = width, crackHeight = height, // needle (uCrack) layout
    tile = false,
  } = opts;
  let g = liftTextureWindowSample(rawGlsl, { width, height, crackWidth, crackHeight, highp: true });
  g = needleLengthUniform(g);
  if (tile) g = tileOffsetUniform(g);
  const fired = g !== String(rawGlsl);
  return { glsl: packFragmentResultToRGBA(g), fired };
}

// the chunk windows for the template: uniform (start, len) pairs
// (needle in uCrack; the loop bound is uNeedleLen, not a baked literal)
export function templateChunkWindows(nl, chunkSize) {
  const m = Math.max(1, Math.ceil(nl / chunkSize));
  const chunks = [];
  for (let c = 0; c < m; c++) {
    const start = c * chunkSize;
    const len = Math.min(chunkSize, nl - start);
    chunks.push({ c, start, len });
  }
  return { m, chunks };
}

// ── 2c. the STRICT ES 1.00 template (the fixed-geometry fallback) ─
// Some ES 1.00 compilers (verified: this repo's headless-Chromium
// SwiftShader) reject EVERY `while` — even well-formed literal-bound
// ones — accepting only `for i in <constant list>` loops (the backend
// emits a constant-bound `for` for those). The strict template loops a
// CONSTANT maxC (the array cap) and reads the chunk as a per-chunk
// texture whose G channel is a 0/1 validity mask, so padding contributes
// diff·0 = 0 — the compile-once + uniform-window pattern survives with
// NO dynamic bound, at the price of maxC−len masked iterations.
export function fuzzyTemplateStrictShader(maxC = ARR_CAP) {
  const list = Array.from({ length: maxC }, (_, i) => i).join(" ");
  return [
    "x=$frag_x",
    "chunk_start=0",   // → uNeedleStart (chunkStartUniform)
    "score=0",
    "for k in " + list + "; do",
    "    tex_idx=$(( chunk_start + k + x ))",   // haystack window (uTex)
    "    crack_idx=$(( k ))",                    // needle chunk window (uCrack)
    "    diff=$(( cr_r - tex_r ))",
    "    if [ $diff -lt 0 ]; then diff=$((-diff)); fi",
    "    mask=$(( cr_g / 255 ))",                // 255 = real digit, 0 = padding
    "    score=$(( score + diff * mask ))",
    "done",
    "putb $(( score ))",
  ].join("\n");
}

// the strict template GLSL pipeline: window lift (tex_r + cr_r + cr_g)
// → the chunk-start uniform → (optional) the offset tile uniform → the
// pack.
export function compileStrictTemplateGLSL(rawGlsl, opts = {}) {
  const { width = 4096, height = 1, crackWidth = width, crackHeight = height, tile = false } = opts;
  let g = liftTextureWindowSample(rawGlsl, { width, height, crackWidth, crackHeight, highp: true });
  g = chunkStartUniform(g);
  if (tile) g = tileOffsetUniform(g);
  const fired = g !== String(rawGlsl);
  return { glsl: packFragmentResultToRGBA(g), fired };
}

// the per-chunk uCrack texture for the strict template: the chunk's
// digits in R (padded to maxC with zeros) and a 0/1 validity mask in G.
export function chunkMaskTexture(chunk, maxC = ARR_CAP, width = 4096) {
  const data = new Uint8Array(width * 4);
  for (let j = 0; j < maxC; j++) {
    const valid = j < chunk.len;
    data[j * 4] = valid ? chunk.digits[j] : 0;
    data[j * 4 + 1] = valid ? 255 : 0;
    data[j * 4 + 3] = 255;
  }
  return data;
}

// chunk windows for the strict template: each chunk carries its own
// digits (the source is geometry-only, the chunk data is a texture)
export function templateStrictChunks(needle, maxC = ARR_CAP) {
  const nl = needle.length;
  const m = Math.max(1, Math.ceil(nl / maxC));
  const chunks = [];
  for (let c = 0; c < m; c++) {
    const start = c * maxC;
    const len = Math.min(maxC, nl - start);
    chunks.push({ c, start, len, digits: needle.slice(start, start + len) });
  }
  return { nl, m, chunks };
}

// ── 3. the optimise transform wiring: RGBA-pack the chunk GLSL ──
// The backend emits a single-byte `out_buf[0] = g_score;` (one putb →
// low byte only). packFragmentResultToRGBA rewrites that ONE write into
// the four little-endian byte writes + the A≥128 sentinel. Returns the
// packed GLSL and whether the transform actually fired.
export function packChunkGLSL(glsl) {
  const packed = packFragmentResultToRGBA(glsl);
  return { glsl: packed, fired: packed !== String(glsl) };
}

// ── 3. the CPU reduce (the "run the reduce on the CPU" half) ───────
// partials[c] = Int32Array of offsets (decoded RGBA). Exact in JS.
export function reducePartials(partials, offsets) {
  const total = new Int32Array(offsets);
  for (const p of partials) {
    if (p.length !== offsets) throw new Error("reducePartials: partial length mismatch");
    for (let x = 0; x < offsets; x++) total[x] += p[x];
  }
  let best = Infinity, bestX = -1;
  for (let x = 0; x < offsets; x++) {
    if (total[x] < best) { best = total[x]; bestX = x; }
  }
  return { total, best, bestX };
}

// decode a readPixels RGBA row (4 bytes/pixel) into per-pixel int
// scores; the A≥128 sentinel is surfaced as -1 (never happens while
// the chunk bound holds — this is the check that proves it).
export function decodeRGBA(px, offsets) {
  const scores = new Int32Array(offsets);
  let sentinels = 0;
  for (let x = 0; x < offsets; x++) {
    const r = px[x * 4], g = px[x * 4 + 1], b = px[x * 4 + 2], a = px[x * 4 + 3];
    if (a >= 128) { scores[x] = -1; sentinels++; continue; }
    scores[x] = r + 256 * g + 65536 * b + 16777216 * a;
  }
  return { scores, sentinels };
}

// ── the CPU reference (the correctness oracle the bench compares to) ─
export function cpuFuzzy(needle, haystack) {
  const nl = needle.length, hl = haystack.length, offsets = hl - nl + 1;
  const scores = new Int32Array(offsets);
  let best = Infinity, bestX = -1;
  for (let x = 0; x < offsets; x++) {
    let s = 0;
    for (let i = 0; i < nl; i++) s += Math.abs(needle[i] - haystack[i + x]);
    scores[x] = s;
    if (s < best) { best = s; bestX = x; }
  }
  return { scores, best, bestX };
}

// ── 4. node-faithful verification of the EMITTED pack text ────────
// The pack transform writes four ES 1.00 byte formulas for the score
// expression (no `%`/shifts — `x − 256*(x/256)` form). This parses the
// TRANSFORMED GLSL text itself and evaluates the formulas in JS, so the
// bench verifies the emitted code (not a parallel reimplementation):
//    evalPackedBytes("…out_buf[0] = ((g_score) - (256 * ((g_score) / 256))); …", score)
// returns [r,g,b,a] exactly as the shader would write them.

// evaluate a GLSL int expression (the emitted forms: identifiers, ints,
// `+ - * / ( )`, unary minus — int div truncates toward zero) with an
// environment. This is what the pack-formula and window-uv checks use.
export function evalGLSLInt(expr, env = {}) {
  return evalArith(expr, env);
}

function evalArith(expr, env) {
  const s = expr.replace(/[A-Za-z_]\w*/g, (m) => String(env[m] ?? 0));
  let pos = 0;
  const peek = () => s[pos];
  const eat = (c) => { if (s[pos] === c) pos++; else throw new Error("arith: expected " + c + " at " + pos + " in " + s); };
  const num = () => {
    while (s[pos] === " ") pos++;
    if (s[pos] === "(") { eat("("); const v = expr2(); eat(")"); return v; }
    if (s[pos] === "-") { pos++; return -num(); }
    let st = pos;
    while (/[0-9]/.test(s[pos] || "")) pos++;
    if (st === pos) throw new Error("arith: no number at " + pos + " in " + s);
    return Number(s.slice(st, pos));
  };
  const atom = () => { while (s[pos] === " ") pos++; return num(); };
  const term = () => {
    let v = atom();
    for (;;) {
      while (s[pos] === " ") pos++;
      if (s[pos] === "*") { pos++; v *= atom(); }
      else if (s[pos] === "/") { pos++; const d = atom(); v = Math.trunc(v / d); } // GLSL int div
      else break;
    }
    return v;
  };
  const expr2 = () => {
    let v = term();
    for (;;) {
      while (s[pos] === " ") pos++;
      if (s[pos] === "-") { pos++; v -= term(); }
      else if (s[pos] === "+") { pos++; v += term(); }
      else break;
    }
    return v;
  };
  return expr2();
}

// extract the four byte formulas from packed GLSL text
export function parsePackedBytes(glsl) {
  const bytes = [];
  for (let i = 0; i < 4; i++) {
    const m = new RegExp(`out_buf\\[${i}\\] = ([^;]+);`).exec(glsl);
    if (!m) return null;
    bytes.push(m[1].trim());
  }
  return bytes;
}

export function evaluatePackedBytes(formulas, score) {
  const env = { g_score: score };
  return formulas.map((f) => evalArith(f, env));
}

// the naive reference bytes — what the pack MUST equal
export function naiveBytes(v) {
  if (v < 0) return [0, 0, 0, 255]; // sentinel
  return [(v / 1) % 256 | 0, (v / 256) % 256 | 0, (v / 65536) % 256 | 0, (v / 16777216) % 256 | 0];
}
