// ─── py-worker.js — the Python engine in a CLASSIC worker ───────
//
// micropython's glue is a classic emscripten script: it declares a
// global `var Module` and fetches its wasm itself. That makes a CLASSIC
// worker mandatory, for two independent reasons:
//
//   1. `importScripts()` is illegal in a module worker (it throws
//      "Module scripts don't support importScripts()");
//   2. a dynamic `import()` of the glue DOES evaluate it, but `var
//      Module` then lands in module scope — `self.Module` stays
//      undefined, so the engine is unreachable.
//
// So this file is deliberately a plain (non-module) worker. It loads the
// engine with importScripts, and because src/py.js is ESM it is pulled in
// with a dynamic import() — which is allowed here (dynamic import works
// in classic workers; only importScripts is module-worker-hostile).
//
// Protocol (mirrors otranspile-job.js):
//   main → worker: { type: "job", jobId, source, stdout?: "capture" }
//   worker → main: { type: "status", jobId, text }
//   worker → main: { type: "done", jobId, ok, result|error }
//   result = { out, err, code }
//
// ONE JOB AT A TIME: micropython's asyncify engine may only have a single
// mp_js_do_str in flight. If a second job arrives while one is running
// (the page could not cancel/restart in time, or a stale post), reject it
// cleanly instead of entering the engine — otherwise emscripten aborts the
// whole worker with "Cannot have multiple async operations in flight at
// once" and every later run is lost.
//
// Output routing: the glue needs a sink (see the LOCAL PATCH in
// www/vendor/micropython.js). py.js installs Module.onStdout for the
// worker realm, so stdout arrives here as plain strings.
// -----------------------------------------------------------------

/* global importScripts, self */

var PY_SRC = "../../src/py.js";  // relative to this file (www/vendor/)
var _pyMod = null;
var _running = false;

self.onmessage = async function (e) {
  var m = e.data || {};
  if (m.type === "init") { self.postMessage({ type: "ready" }); return; }
  if (m.type !== "job") return;

  var post = function (o) { self.postMessage(o); };
  var status = function (text) { post({ type: "status", jobId: m.jobId, text: String(text) }); };

  if (_running) {
    post({ type: "done", jobId: m.jobId, ok: false, error: "a run is already in progress" });
    return;
  }
  _running = true;
  try {
    status("loading the Python engine…");
    if (!_pyMod) _pyMod = await import(PY_SRC);
    var py = await _pyMod.getPyEngine();

    var out = "", err = "";
    status("running python…");
    // py.js handles the worker realm: the glue's stdout chars are routed
    // through Module.onStdout to the writer we pass here.
    var code = await _pyMod.pyExec(String(m.source), {
      stdout: { write: function (s) { out += s; } },
      stderr: { write: function (s) { err += s; } },
    });
    post({ type: "done", jobId: m.jobId, ok: true, result: { out: out, err: err, code: code } });
  } catch (e2) {
    post({ type: "done", jobId: m.jobId, ok: false, error: String((e2 && e2.message) || e2) });
  } finally {
    _running = false;
  }
};
