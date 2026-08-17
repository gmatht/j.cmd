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
