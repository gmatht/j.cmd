// ─── shglsl-auto.js — the automatic shader pipeline (a)–(d) ─────
//
// The vision: replace the explicit `sh2glsl` step with a plain eval —
// the runtime runs the bash as a normal shell program, and this module
// automatically decides whether to transparently offload it to the GPU.
// The four questions, and the signals that answer them:
//
//   (a) PRE-COMPILE & REUSE — the bash→GLSL translation is a pure
//       function of the source text, so it is always cacheable by
//       source hash (the `getShaderTranslation` cache). `static`
//       additionally reports whether the program is self-contained
//       (no `eval`/`source`/`.` — it is not a code generator whose
//       real program only exists at runtime).
//   (b) IS IT A SHADER — the program compiles to a WORKING shader in
//       at least one stage (the glslCapable verdict: clean footer, no
//       recursion, no stage-contract violation).
//   (c) WHAT SORT — the output model decides the stage: byte output
//       (putb/echo/printf) is fragment-only, vp_*/vc_*/vu_* writes are
//       vertex-only, so a program is exactly one of fragment | vertex |
//       null (a program that does both is broken in both stages, and a
//       program with no output is not a shader at all).
//   (d) WORTH IT — the GPU path has fixed overhead (compile, upload,
//       render, readback), so it only pays when the work is
//       INVOCATION-PARAMETERIZED (the program reads the stage's input
//       bridges — otherwise the GPU computes the same result N times
//       redundantly and the single CPU eval always wins) AND the
//       invocation count is large enough (pixels ≥ 4096 for a
//       fragment, vertices ≥ 256 for a vertex). `x=3` fails (a)–(d):
//       no output, no bridges, trivial.
//
// The bridge-read signal is the backend's own use-gating: the input
// bridges (frag_x/tex_*/ap_*/ucp_*/…) are declared in the rendered
// GLSL ONLY when the program reads them, so the raw renders are the
// ground truth for "does this program depend on the invocation".
//
//   node --input-type=module -e "import{analyzeShader}from'./src/shglsl-auto.js';console.log(await analyzeShader('putb \$((frag_x % 256))'))"

import { getOtranspilerl } from "./otranspilerl.js";
import { glslCapable } from "./shglsl-capable.js";

// the input-bridge globals, exactly as the backend names them (the
// use-gated declarations in the raw renders)
const FRAG_BRIDGES = [
  "g_frag_x", "g_frag_y",
  "g_vcolor_r", "g_vcolor_g", "g_vcolor_b",
  "g_uv_x", "g_uv_y",
  "g_tex_r", "g_tex_g", "g_tex_b",
  "g_damage", "g_cr_r", "g_cr_g", "g_cr_b", "g_cr_a",
];
const VERT_BRIDGES = [
  "g_ap_x", "g_ap_y", "g_ap_z",
  "g_ash_r", "g_ash_g", "g_ash_b",
  "g_auv_u", "g_auv_v",
  "g_ucp_x", "g_ucp_y", "g_ucp_z",
  "g_ucy_m", "g_ucs",
  "g_uop_x", "g_uop_y", "g_uop_z",
  "g_usc_x", "g_usc_y", "g_usc_z",
  "g_ublk_r", "g_ublk_g", "g_ublk_b",
  "g_uov",
];

// (d) thresholds — below these the fixed GPU overhead dominates
const MIN_PIXELS = 4096;   // a 64×64 canvas
const MIN_VERTICES = 256;

// ── (a) self-modification detection ──────────────────────────────
// `eval`/`source`/`.` mean the program is a code generator — its real
// program only exists at runtime, so the static source text is not the
// whole story (the translation of the text is still valid and cached,
// but the program is not "static" in the pre-compile sense).
function findSelfModifying(a1) {
  const out = [];
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (typeof node === "object") {
      if (node.type === "Call" && node.func === "builtin") {
        const first = node.args?.[0];
        if (first && first.type === "Str" && ["eval", "source", "."].includes(first.value)) {
          out.push(first.value);
        }
      }
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(a1?.stmts ?? []);
  return out;
}

// ── (d) per-invocation work estimate (context for the verdict) ────
function countLoops(a1) {
  let n = 0;
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (typeof node === "object") {
      if (node.type === "While" || node.type === "For") n++;
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(a1?.stmts ?? []);
  return n;
}

function countOps(a1) {
  let n = 0;
  const walk = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (typeof node === "object") {
      if (node.type === "Arith" || node.type === "Bin" || node.type === "IncDec") n++;
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(a1?.stmts ?? []);
  return n;
}

// ── the translation cache (a): source text → both-stage GLSL ─────
// The translation is a pure function of the source, so the source
// string IS the key — no hashing, no invalidation logic, and any
// re-eval of the same program reuses the compiled shaders.
const cache = new Map();

export function shaderCache() {
  return cache;
}

// Compile (or reuse) the fragment + vertex translations for a source.
// Returns { key, frag, vert, report, hit }.
export async function getShaderTranslation(src, { lib, view = 800 } = {}) {
  lib ??= await getOtranspilerl();
  const key = String(src);
  const hit = cache.get(key);
  if (hit) return { ...hit, hit: true };
  const report = await glslCapable(key, { lib });
  const frag = lib.raw("otranspilerl_glsl", [key], [view]).output;
  const vert = lib.raw("otranspilerl_glslv", [key], [view]).output;
  const entry = { key, frag, vert, report, hit: false };
  cache.set(key, entry);
  return entry;
}

// ── the full (a)–(d) verdict ─────────────────────────────────────
export async function analyzeShader(src, { lib, view = 800, pixels, vertices } = {}) {
  lib ??= await getOtranspilerl();
  const srcStr = String(src);
  const a1 = JSON.parse(lib.shir(srcStr));
  const report = await glslCapable(srcStr, { lib });
  const frag = lib.raw("otranspilerl_glsl", [srcStr], [view]).output;
  const vert = lib.raw("otranspilerl_glslv", [srcStr], [view]).output;

  // (a) static: self-contained (no eval/source/.)
  const selfModifying = findSelfModifying(a1);

  // (c) the output model decides the stage — a program is exactly one
  // of fragment | vertex | null (byte output breaks the vertex stage,
  // vp_* output is meaningless in the fragment, no output is not a
  // shader)
  const kind = report.fragment.capable ? "fragment" : report.vertex.capable ? "vertex" : null;

  // (d) worth: invocation-parameterized (reads the stage's bridges —
  // the backend's use-gated declarations in the raw renders) AND the
  // invocation count is large enough
  const readsFrag = FRAG_BRIDGES.some((b) => frag.includes(b));
  const readsVert = VERT_BRIDGES.some((b) => vert.includes(b));
  const nPixels = pixels ?? view * 600;
  const nVertices = vertices ?? 4096;
  const loops = countLoops(a1);
  const ops = countOps(a1);
  const worthFrag = readsFrag && nPixels >= MIN_PIXELS;
  const worthVert = readsVert && nVertices >= MIN_VERTICES;
  const worth =
    kind === "fragment" ? worthFrag : kind === "vertex" ? worthVert : false;

  return {
    // (a)
    static: selfModifying.length === 0,
    selfModifying,
    // (b) + (c)
    shader: kind !== null,
    kind,
    // (d)
    worth,
    readsFrag,
    readsVert,
    loops,
    ops,
    pixels: nPixels,
    vertices: nVertices,
    // the per-stage detail (capable / unsupported / warnings)
    report,
  };
}

// ── the runtime decision ──────────────────────────────────────────
// The eval-fallback contract: offload = it IS a shader AND worth it
// AND static. When offload is true the caller renders the cached
// translation on the GPU; otherwise it evals the bash normally.
export async function shouldOffload(src, opts = {}) {
  const a = await analyzeShader(src, opts);
  return { offload: a.shader && a.worth && a.static, ...a };
}

// ── CLI: `node src/shglsl-auto.js file.sh` ───────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFile } = await import("node:fs/promises");
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node src/shglsl-auto.js file.sh");
    process.exit(1);
  }
  const src = await readFile(file, "utf8");
  console.log(JSON.stringify(await analyzeShader(src), null, 2));
}
