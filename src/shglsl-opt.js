// ─── shglsl-opt.js — the sh→GLSL ES 1.00 fragment-shader optimizer ──
//
// The otranspilerl wasm renders the bash-authored fragment program as a
// faithful FIXED-POINT transcription: every colour op is integer math in
// millis/0..127/0..255 scales, and the CRT/corruption modulos are
// emulated as `x - d*(x/d)` (GLSL ES 1.00 has no `%` or bitwise ops —
// they are ES 3.00-only, so the emulation is required). Measured on the
// game's 800×600 fragment workload (headless-gl, best-of-5): the integer
// division pipeline costs ~30-40% more ALU than the same chain in
// native mediump float — and the exact modulo can be expressed as
// `int(mod(float(x), d))` (bit-identical for x < 2^24, which the
// pixel-centre coords and the corruption hash both satisfy).
//
// This module is the JS-side equivalent of a glsl_backend.rs lowering
// pass (the Rust source lives in the sh2perl repo, not here): it
// rewrites the GENERATED ES 1.00 fragment shader in place.
//
//   • the two constant modulos → int(mod(float(), float()))   — EXACT
//     (measured 0 pixel diff)
//   • the fixed-point colour chain → native mediump float FMAs —
//     ~38% fewer ALU instructions on the common path (measured);
//     costs ≤2/255 per pixel on ~2-5% of pixels (the int pipeline's
//     per-step truncation vs float rounding — visually invisible)
//
// FAIL-SAFE: the transform only fires when the input matches the
// generated shape (the declaration block, the tint pattern, the exact
// modulo emulations). Anything else — a different program, a changed
// backend output — passes through UNCHANGED, so the game's shaders can
// never be broken by this pass.
//
//   node --input-type=module -e "import{optimizeFragmentGLSL}from'./src/shglsl-opt.js';... "

const GUARDS = [
  "precision mediump float;",            // fragment (not vertex) output
  "precision mediump int;",
  "int out_buf[4];",                     // the generated putb contract
  "vec4 _tex = texture2D(uTex, fract(vUv));",   // the hoisted sample
  "texture2D(uCrack, fract(vUv));",      // the damage overlay sample
  "g_scan = (g_fy - (6 * (g_fy / 6)));", // the CRT modulo emulation
  "g_corrupt = (g_hash - (97 * (g_hash / 97)));", // the corruption modulo
  "g_r = (((g_r * g_tex_r)) / 128);",    // the fixed-point tint
];

// the float-native main() body — same quantize boundaries (int(x*127) /
// int(x*255)), same pixel-centre effect placement, same clamps; the
// colour chain itself runs in mediump float (native FMA, no int-div).
const OPT_MAIN = `void main() {
    int g_frag_x;
    int g_frag_y;
    float g_fr;
    float g_fg;
    float g_fb;
    float g_r;
    float g_g;
    float g_b;
    int g_scan;
    float g_mix;
    int g_hash;
    int g_corrupt;
    int g_vx;
    int g_vy;
    int g_edge;
    int g_dim;

    g_frag_x = int(gl_FragCoord.x);
    g_frag_y = int(gl_FragCoord.y);
    // the 0..127 / 0..255 quantize boundaries are preserved — same
    // colour scale and effect placement as the fixed-point pipeline
    g_fr = float(int(vColor.r * 127.0));
    g_fg = float(int(vColor.g * 127.0));
    g_fb = float(int(vColor.b * 127.0));
    vec4 _tex = texture2D(uTex, fract(vUv));
    g_r = (g_fr * float(int(_tex.r * 255.0))) / 128.0;
    g_g = (g_fg * float(int(_tex.g * 255.0))) / 128.0;
    g_b = (g_fb * float(int(_tex.b * 255.0))) / 128.0;
    g_scan = int(mod(float(g_frag_y), 6.0));
    if ((g_scan == 0)) {
        g_r = (g_r * 0.9);
        g_g = (g_g * 0.9);
        g_b = (g_b * 0.9);
    }
    if ((uDamage > 0)) {
        vec4 _crack = texture2D(uCrack, fract(vUv));
        g_mix = min((float(uDamage) * float(int(_crack.a * 127.0))), 127.0);
        g_r = (g_r - (((g_r - float(int(_crack.r * 127.0)))) * (g_mix / 128.0)));
        g_g = (g_g - (((g_g - float(int(_crack.g * 127.0)))) * (g_mix / 128.0)));
        g_b = (g_b - (((g_b - float(int(_crack.b * 127.0)))) * (g_mix / 128.0)));
    }
    g_hash = (((g_frag_x * 7)) + ((g_frag_y * 13)));
    g_corrupt = int(mod(float(g_hash), 97.0));
    if ((g_corrupt == 0)) {
        g_r = 255.0;
        g_g = (g_g * 0.5);
        g_b = (g_b * 0.5);
    }
    g_vx = (g_frag_x - 400);
    g_vy = (g_frag_y - 300);
    if ((g_vx < 0)) {
        g_vx = (0 - g_vx);
    }
    if ((g_vy < 0)) {
        g_vy = (0 - g_vy);
    }
    g_edge = (g_vx + g_vy);
    if ((g_edge > 450)) {
        g_dim = (g_edge - 450);
        if ((g_dim > 30)) {
            g_dim = 30;
        }
        g_r = (g_r - ((g_r * float(g_dim)) / 256.0));
        g_g = (g_g - ((g_g * float(g_dim)) / 256.0));
        g_b = (g_b - ((g_b * float(g_dim)) / 256.0));
    }
    gl_FragColor = vec4((max(g_r, 0.0)) / 255.0, (max(g_g, 0.0)) / 255.0, (max(g_b, 0.0)) / 255.0, 1.0);
}`;

export function optimizeFragmentGLSL(src) {
  const s = String(src);
  // fail-safe: only the generated MIMEcroft fragment shape is rewritten;
  // any other program (or a changed backend output) passes through.
  for (const g of GUARDS) {
    if (!s.includes(g)) return s;
  }
  const start = s.indexOf("void main() {");
  if (start < 0) return s;
  // the main() body runs to the closing brace at the statement level —
  // find the matching `}` by counting braces (the generated body has no
  // nested braces in comments; the footer comment comes after).
  let depth = 0;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return s;
  return s.slice(0, start).replace("int out_buf[4];\n", "") + OPT_MAIN + s.slice(end);
}

// ─── packFragmentResultToRGBA — widen a single-byte result to 32 bits ─
//
// A compute-style fragment (fuzzy match, factor, …) outputs ONE numeric
// result: the backend emits `out_buf[0] = <score>;`, and gl_FragColor
// carries only the LOW byte (score ≤ 255). This pass rewrites that one
// write into four ES 1.00 little-endian byte writes (R,G,B,A) so the
// score round-trips as a full 32-bit value to the readback.
//
// ES 1.00 has NO integer `%` or bitwise shifts, so each byte uses the
// modulo identity `x % 256 == x - (256 * (x / 256))` with a power-of-two
// integer division for the shift (integer division truncates toward
// zero — exact for the non-negative scores this targets).
//
// FAIL-SAFE (same contract as optimizeFragmentGLSL): it fires ONLY when
// the generated shape is a SINGLE out_buf[0] result — a program that
// already emits out_buf[1..3] (a colour pack, or the game's 4-putb
// RGBA shaders) or multiple result writes passes through UNCHANGED.

const PACK_POS_GUARDS = [
  "int out_buf[4];",                  // the putb contract
  "out_buf[0] =",                     // a byte result write
  "gl_FragColor = vec4(float(out_buf[0])", // the 4-slot colour readback
];
const PACK_NEG_GUARDS = ["out_buf[1] =", "out_buf[2] =", "out_buf[3] ="];

// one ES 1.00 byte of `expr` at byte `shift` (a power of two):
//   byte = (expr / shift) % 256  →  ((expr / shift) - (256 * ((expr / shift) / 256)))
function glslByte(expr, shift) {
  const v = shift === 0 ? `(${expr})` : `((${expr}) / ${shift})`;
  return `(${v} - (256 * (${v} / 256)))`;
}

// The 4-byte RGBA pack is EXACT for every non-negative int: a GLSL int
// is ≤ 2^31-1 (highp) or ≤ 2^15-1 (mediump), both < 2^32 (MAX_RGBA), so
// the little-endian byte decomposition always round-trips. The one
// reservation: for a value ≤ 2^31-1, byte3 = (v/2^24)%256 ≤ 127, so bit 7
// of the A channel is ALWAYS 0 for representable values. We use that
// spare bit as an OVERFLOW/SIGN flag: anything unrepresentable (a
// negative score, or a hypothetical value wider than 32 bits) sets
// A ≥ 128 → the reader sees an explicit sentinel instead of re-adding a
// silently-wrapped number. That is the fallback: never mis-encode, never
// guess — signal "unrepresentable".

export function packFragmentResultToRGBA(src, opts = {}) {
  const s = String(src);
  for (const g of PACK_POS_GUARDS) if (!s.includes(g)) return s;
  for (const g of PACK_NEG_GUARDS) if (s.includes(g)) return s; // already packed / multi-byte
  // exactly ONE out_buf[0] write (a single numeric result, not several)
  if ((s.match(/out_buf\[0\] =/g) || []).length !== 1) return s;
  const m = /([ \t]*)out_buf\[0\] = ([^;]+);/.exec(s);
  if (!m) return s;
  const expr = m[2].trim();
  // not a numeric GLSL expression (a string/array value wouldn't byte-
  // pack): reject anything carrying quotes or array brackets. A plain
  // identifier like `g_score` (no digits) IS numeric — so DON'T gate on
  // digits, only on clearly non-numeric syntax.
  if (/["']|\[|\]/.test(expr)) return s;
  // correctness fallback: if the caller told us the result may be
  // negative (`signed`) or supplied a bound that can exceed 32 bits
  // (`maxScore > MAX_RGBA`), refuse to guarantee an exact pack — fall
  // back to NOT transforming (the safe, untouched single byte) rather
  // than risk corruption. (A plain non-negative int can't, but the
  // option lets the analysis layer opt out when it can't certify.)
  const MAX_RGBA = 0xFFFFFFFF;
  if (opts.signed) return s;
  if (typeof opts.maxScore === "number" && (opts.maxScore < 0 || opts.maxScore > MAX_RGBA)) return s;
  const emitIf = opts.ifSentin !== false;
  const ind = m[1];
  const body = ind + "    ";
  if (!emitIf) {
    // simple exact pack (only correct for non-negative ints — the caller
    // takes responsibility for the bound)
    const writes = [0, 256, 65536, 16777216]
      .map((sh, i) => `${ind}out_buf[${i}] = ${glslByte(expr, sh)};`).join("\n");
    return s.replace(m[0], writes);
  }
  // guarded pack + sentinel fallback: representable (non-negative int)
  // → exact bytes; anything else → explicit sentinel {0,0,0,255}.
  const packed =
    `${ind}if ((${expr}) >= 0) {\n` +
    `${body}out_buf[0] = ${glslByte(expr, 0)};\n` +
    `${body}out_buf[1] = ${glslByte(expr, 256)};\n` +
    `${body}out_buf[2] = ${glslByte(expr, 65536)};\n` +
    `${body}out_buf[3] = ${glslByte(expr, 16777216)}; // A ≤ 127 (bit 7 = 0 = valid)\n` +
    `${ind}} else {\n` +
    `${body}/* fallback: unrepresentable (negative / > 32-bit) → sentinel, reader sees A ≥ 128 */\n` +
    `${body}out_buf[0] = 0; out_buf[1] = 0; out_buf[2] = 0; out_buf[3] = 255;\n` +
    `${ind}}`;
  return s.replace(m[0], packed);
}

// ─── liftTextureWindowSample — the texture-window data-load pass ──
//
// The backend's tex_* bridge samples ONE hoisted texel at `fract(vUv)`
// — and only for a top-level read. A tex read INSIDE a loop emits NO
// sample at all (`g_tex_r` is declared, never assigned → uninitialized,
// the loop silently reads the same garbage every iteration). The
// fragment cannot index the texture by a program value at all.
//
// This pass rewrites the generated fragment so every tex_* USE becomes
// a per-use sample at a PROGRAM-SET index (the convention: the bash
// assigns `tex_idx` before reading `tex_r`):
//
//     texture2D(uTex, windowUV(g_tex_idx))     // uv from a W×H layout
//
// The fuzzy texture-window shader sets `tex_idx = chunk_start + i + x`
// inside its needle loop, so each iteration fetches haystack[i+x] from
// the uploaded haystack texture — the haystack stops being an inline
// array (ARR_CAP 1024) and becomes texture data (W×H, any size up to
// the texture capacity). The pass:
//
//   • strips the hoisted `vec4 _tex = texture2D(uTex, fract(vUv));`
//     sample and the dead `g_tex_r = int(_tex.r * 255.0);` line;
//   • replaces every tex channel USE (not declaration/assignment) with
//     `int(texture2D(uTex, <uv of g_tex_idx>).<ch> * 255.0)`;
//   • promotes the fragment to highp float when asked (the wide-texture
//     uv math AND the texel /255 decode both need > mediump mantissa —
//     at mediump fp16 the (idx+0.5)/W coordinate and the digit/255×255
//     round-trip both break past ~2K texels);
//   • FAIL-SAFE: fires only when the generated shape is present AND the
//     shader declares the index variable (`g_tex_idx`); any other
//     program passes through unchanged.
export function liftTextureWindowSample(src, opts = {}) {
  const s = String(src);
  const width = opts.width || 4096;   // the texture layout (W×H texels)
  const height = opts.height || 1;
  const indexVar = opts.indexVar || "g_tex_idx";
  const highp = opts.highp !== false;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return s;
  // guards: the putb contract + the index variable must exist + at least
  // one tex channel is read somewhere
  if (!s.includes("int out_buf[4];")) return s;
  if (!new RegExp(`int ${indexVar};`).test(s)) return s;
  const chRe = /g_tex_[rgba]/.test(s);
  if (!chRe) return s;

  // the per-index window UV (texel centre; CLAMP_TO_EDGE, NEAREST):
  //   1D (height=1):  vec2((float(idx)+0.5)/W, 0.5)
  //   2D (W×H):       col = idx − W·(idx/W)  (int div — exact for ≥0)
  //                   row = idx / W
  //                   uv  = ((float(col)+0.5)/W, (float(row)+0.5)/H)
  const col = `(${indexVar} - (${width} * (${indexVar} / ${width})))`;
  const row = `(${indexVar} / ${width})`;
  const uv = height === 1
    ? `vec2((float(${indexVar}) + 0.5) / ${width}.0, 0.5)`
    : `vec2((float(${col}) + 0.5) / ${width}.0, (float(${row}) + 0.5) / ${height}.0)`;

  let out = s;
  // strip the hoisted sample + its dead assignment (the per-use samples
  // replace them)
  out = out.replace(/^\s*vec4 _tex = texture2D\(uTex, fract\(vUv\)\);\n/gm, "");
  out = out.replace(/^\s*g_tex_[rgba] = int\(_tex\.[rgba] \* 255\.0\);\n/gm, "");
  // replace every channel USE with a per-use windowed sample. The
  // declaration (`int g_tex_r;`) and assignments (`g_tex_r = …`) are
  // excluded: the decl is followed by `;`, assignments by ` =`.
  const sample = (ch) =>
    `int(texture2D(uTex, ${uv}).${ch} * 255.0)`;
  for (const ch of ["r", "g", "b", "a"]) {
    out = out.replace(
      new RegExp(`(?<![A-Za-z0-9_])g_tex_${ch}(?![A-Za-z0-9_])(?!\\s*=|;)`, "g"),
      () => sample(ch)
    );
  }
  if (out === s) return s; // nothing changed (no use sites)
  if (highp) out = out.replace("precision mediump float;", "precision highp float;");
  return out;
}
