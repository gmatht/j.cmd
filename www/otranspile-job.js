// ─── otranspile-job.js — Web Worker entry for one otranspiler stage ───
//
// A REAL module worker file (not a blob): relative imports resolve
// against this file, so no URL injection is needed except the
// otranspilerl wasm (absolute — the page passes it in the `init`
// message, same mechanism as bgworker's __SH2_OTRANSPILERL_WASM_URL).
//
// Protocol (no shared memory — plain postMessage, so this works
// without cross-origin isolation):
//   main → worker: { type: "init", wasmUrl }          (once; → "ready")
//   main → worker: { type: "job", jobId, kind, ... }  kind: "transpile"
//                    { source, srcLang, tgt }  → { text, map, a1, optShir, lex }
//                    kind: "annotate" { source, mode } → py2cy typed Cython
//                    { text, mode, decls, refusals, stats }
//                    kind: "run" { lang, code } → { out, err, code, note? }
//                    kind: "version"             → { version }
//   worker → main: { type: "status", jobId, text }    (progress notes)
//   worker → main: { type: "done", jobId, ok, result|error }
//
// One job at a time per worker: the page runs three workers (transpile,
// original, target) and terminates + respawns a worker to cancel a
// superseded job — terminate() kills even a wedged wasm loop, which a
// cooperative cancel flag could not.
// -------------------------------------------------------------------

import { fs } from "../src/fs/index.js";
import { env } from "../src/env.js";
import { transpileJob, runJob, annotateJob, otranspilerVersion } from "../src/otranspile-jobs.js";

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === "init") {
    if (m.wasmUrl) globalThis.__SH2_OTRANSPILERL_WASM_URL = String(m.wasmUrl);
    self.postMessage({ type: "ready" });
    return;
  }
  if (m.type !== "job") return;
  const ctx = {
    fs, env,
    onStatus: (text) => self.postMessage({ type: "status", jobId: m.jobId, text: String(text) }),
  };
  try {
    let result;
    if (m.kind === "transpile") {
      result = await transpileJob(m.source, m.srcLang, m.tgt, ctx);
    } else if (m.kind === "annotate") {
      result = await annotateJob(m.source, m.mode, ctx);
    } else if (m.kind === "run") {
      result = await runJob(m.lang, m.code, ctx);
    } else if (m.kind === "version") {
      result = { version: await otranspilerVersion() };
    } else {
      throw new Error("unknown job kind: " + m.kind);
    }
    self.postMessage({ type: "done", jobId: m.jobId, ok: true, result });
  } catch (err) {
    self.postMessage({ type: "done", jobId: m.jobId, ok: false, error: String((err && err.message) || err) });
  }
};
