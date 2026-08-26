// ─── shglsl-capable.js — automatic GPU-capability detection ─────
//
// Does this bash program compile to a WORKING vertex and/or fragment
// shader? The sh→GLSL backend (glsl_backend.rs) renders unsupported
// constructs as `/* TODO(unsupported): what */` markers with a footer
// count — that count is the "capable" signal the docs tell you to
// check by hand. This module makes it automatic, and closes the three
// gaps where the footer lies:
//
//   1. RECURSION — GLSL forbids it, but the backend emits a self-call
//      with a clean "0 construct(s)" footer (the shader then fails to
//      compile). Detected by walking the A1 shIR call graph.
//   2. BYTE OUTPUT IN A VERTEX PROGRAM — `echo`/`print`/`printf`/
//      `putb` lower to putStr/putCh/out_buf, which are FRAGMENT-only
//      (out_buf/out_len are never declared in a vertex shader — the
//      generated shader is broken with a clean footer). A vertex
//      program must output through the vp_*/vc_*/vu_* vars instead.
//   3. NO OUTPUT AT ALL — a fragment program that only sets vp_*/vc_*/
//      (or a vertex program that only echoes) compiles but renders
//      nothing. Reported as a warning, not a blocker.
//
// The verdict per stage: capable = clean footer (0 unsupported) + no
// recursion + no stage-contract violation. The report also lists the
// unsupported constructs (what + count) so the author knows exactly
// what to remove.
//
//   node --input-type=module -e "import{glslCapable}from'./src/shglsl-capable.js';console.log(await glslCapable('echo hi'))"
//
// The wasm's glsl/glslv renders are the ground truth (the same
// otranspilerl_glsl / _glslv exports `sh2glsl` drives); the marker
// format and the footer are a stable contract (see
// WRITING_GPU_SHADERS_IN_BASH.md §4/§6).

import { getOtranspilerl } from "./otranspilerl.js";

// ── marker parsing ───────────────────────────────────────────────
// The footer count is authoritative (it is the renderer's `todo`
// counter); the markers give the per-construct breakdown. Marker
// forms (all counted except the asm-label line comment):
//   /* TODO(unsupported): exec ls */          (mark_todo)
//   /* TODO(i64→i32 wrap: 999999999999) */    (expr_num/expr_str)
//   /* TODO(call split) */  /* TODO(arith parse) */  /* TODO(cmdsub num) */
//   // TODO(unsupported): asm label 'x' on an assign   (NOT counted)
// The footer line itself (`// TODO(unsupported): N construct(s) — …`)
// is excluded from the breakdown.
function parseUnsupported(glsl) {
  const footer = glsl.match(/\/\/ TODO\(unsupported\): (\d+) construct/);
  const total = footer ? parseInt(footer[1], 10) : 0;
  const counts = new Map();
  // marker forms: `TODO(tag)` or `TODO(tag): description` — the
  // description has NO closing paren (`/* TODO(unsupported): exec ls */`),
  // and the block form ends with a space before `*/`. Capture the tag up
  // to the first `)` and the description after `: `.
  const re = /\/\/\s*TODO\(([^)]*)\)(?:\s*:\s*([^\n]*))?|\/\*\s*TODO\(([^)]*)\)(?:\s*:\s*([^*]*))?\s*\*\//g;
  let m;
  while ((m = re.exec(glsl)) !== null) {
    const tag = (m[1] ?? m[3] ?? "").trim();
    const desc = (m[2] ?? m[4] ?? "").trim();
    if (desc.includes("construct(s)")) continue; // the footer line itself
    const what = (desc || tag).trim();
    if (!what) continue;
    counts.set(what, (counts.get(what) ?? 0) + 1);
  }
  return {
    total,
    unsupported: [...counts.entries()].map(([what, count]) => ({ what, count })),
  };
}

// ── recursion detection (the footer's blind spot) ───────────────
// Walk the A1 shIR JSON: collect the user-function bodies, build the
// function→function call graph (an `exec` call whose first arg is a
// Str naming a defined function — exactly the backend's `fns` test),
// and DFS for cycles. Returns the members of the first cycle found
// (or []). GLSL forbids recursion in every stage, so a cycle makes
// both stages incapable.
function findRecursion(a1) {
  const fns = new Map(); // name → body stmts
  for (const s of a1?.stmts ?? []) {
    if (s && s.type === "Function") fns.set(s.name, s.body ?? []);
  }
  if (fns.size === 0) return [];
  // every `exec` call to a defined function inside a body
  const callsTo = (body) => {
    const out = [];
    const walk = (node) => {
      if (node == null) return;
      if (Array.isArray(node)) {
        for (const n of node) walk(n);
        return;
      }
      if (typeof node === "object") {
        if (node.type === "Call" && node.func === "exec") {
          const first = node.args?.[0];
          if (first && first.type === "Str" && fns.has(first.value)) {
            out.push(first.value);
          }
        }
        for (const v of Object.values(node)) walk(v);
      }
    };
    walk(body);
    return out;
  };
  const state = new Map(); // 0 unvisited · 1 in-stack · 2 done
  const stack = [];
  const dfs = (n) => {
    state.set(n, 1);
    stack.push(n);
    for (const c of callsTo(fns.get(n) ?? [])) {
      const st = state.get(c) ?? 0;
      if (st === 1) {
        // cycle: c … top of stack, closed by c
        const i = stack.indexOf(c);
        return stack.slice(i).concat(c);
      }
      if (st === 0) {
        const cyc = dfs(c);
        if (cyc) return cyc;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const name of fns.keys()) {
    if ((state.get(name) ?? 0) === 0) {
      const cyc = dfs(name);
      if (cyc) return cyc;
    }
  }
  return [];
}

// ── the detector ─────────────────────────────────────────────────
// Runs the fragment and vertex renders, parses each footer, adds the
// recursion verdict, and applies the stage-contract rules:
//   fragment: byte output (putb/echo/printf) is the output model;
//             vp_*/vc_*/vu_* writes compile but render nothing (warn).
//   vertex:   byte output is BROKEN (out_buf undeclared) — blocker;
//             a program that sets no vp_*/vc_*/vu_* renders nothing
//             (warn).
// The RAW wasm renders are used (not the shglsl-opt optimized glsl()
// wrapper — the optimizer rewrites the byte-buffer pipeline away, so
// the markers and the out_buf contract only exist in the raw output).
// `lib` may be passed in (a resolved getOtranspilerl() promise) to
// avoid re-loading the wasm when the caller already has it.
export async function glslCapable(src, { lib } = {}) {
  lib ??= await getOtranspilerl();
  const srcStr = String(src);
  const frag = lib.raw("otranspilerl_glsl", [srcStr], [800]).output;
  const vert = lib.raw("otranspilerl_glslv", [srcStr], [800]).output;
  const recursion = findRecursion(JSON.parse(lib.shir(srcStr)));

  const fragReport = parseUnsupported(frag);
  const vertReport = parseUnsupported(vert);

  // stage-contract checks on the RENDERED output (what the backend
  // actually emitted — more robust than re-parsing the source).
  // `out_buf[` alone is the fragment boilerplate (the declaration + the
  // gl_FragColor readback) — a real byte WRITE is `out_buf[N] = …`
  // (putb) or a putStr/putCh call (echo/printf). A vertex shader has
  // no out_buf at all, so ANY out_buf[ there is a broken putb.
  const fragHasByteOut = /putStr\(|putCh\(|out_buf\[\d+\]\s*=/.test(frag);
  const fragHasVertOut = /g_vp_[xyzw]\s*=/.test(frag);
  const vertHasByteOut = /putStr\(|putCh\(|out_buf\[/.test(vert);
  const vertHasVertOut = /g_vp_[xyzw]\s*=/.test(vert);

  const fragWarnings = [];
  if (!fragHasByteOut && !fragHasVertOut) {
    fragWarnings.push("no output at all — the shader renders nothing");
  } else if (!fragHasByteOut && fragHasVertOut) {
    fragWarnings.push(
      "only sets vp_*/vc_*/vu_* (vertex outputs) — a fragment shader has no gl_Position; renders nothing"
    );
  }
  const vertWarnings = [];
  if (vertHasByteOut) {
    vertWarnings.push(
      "byte output (echo/print/printf/putb) is not representable in a vertex shader — out_buf/out_len are fragment-only and undeclared here; output through vp_*/vc_*/vu_* instead"
    );
  } else if (!vertHasVertOut) {
    vertWarnings.push("no vp_*/vc_*/vu_* output — the vertex shader renders nothing");
  }

  const fragCapable =
    fragReport.total === 0 && recursion.length === 0 && fragWarnings.length === 0;
  const vertCapable =
    vertReport.total === 0 && recursion.length === 0 && vertWarnings.length === 0;

  return {
    recursion,
    fragment: {
      capable: fragCapable,
      total: fragReport.total,
      unsupported: fragReport.unsupported,
      warnings: fragWarnings,
    },
    vertex: {
      capable: vertCapable,
      total: vertReport.total,
      unsupported: vertReport.unsupported,
      warnings: vertWarnings,
    },
  };
}

// ── CLI: `node src/shglsl-capable.js file.sh` ────────────────────
// Prints the report as JSON (the shell's `sh2glsl --check` drives the
// same function through src/otranspilerl.js).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFile } = await import("node:fs/promises");
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node src/shglsl-capable.js file.sh");
    process.exit(1);
  }
  const src = await readFile(file, "utf8");
  console.log(JSON.stringify(await glslCapable(src), null, 2));
}
