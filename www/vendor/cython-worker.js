// ─── cython-worker.js — the real Cython 3.3.0 compiler, in wasm ──
//
// CPython 3.12 + stdlib compiled to wasm (Pyodide 0.26.2, vendored under
// ./pyodide/) runs the actual Cython compiler. Cython 3.3.0 is a
// PURE-PYTHON wheel (py3-none-any), so it zipimports straight from
// ./cython-3.3.0-py3-none-any.whl — offline, no micropip, no PyPI.
//
// This file is deliberately a CLASSIC worker: Pyodide's runtime detector
// throws "Cannot determine runtime environment" in a MODULE worker, because
// its loader needs importScripts (a module worker does not have it).
//
// Protocol (mirrors py-worker.js / otranspile-job.js):
//   main → worker: { type: "init" }
//   worker → main: { type: "ready", version }
//   main → worker: { type: "job", jobId, source, mode: "pure" | "pyx" }
//   worker → main: { type: "done", jobId, ok, result|error }
//     result = { errors, err, log, c, clines }   (c = the emitted C)
//
// The same acceptance gate as bench/py2cy-smoke.mjs (`cython --embed`), but
// in the browser: 0 errors ⇔ the annotated file is valid Cython. Building
// the emitted C into a loadable extension still needs emscripten + the
// Python headers, which is a CI step, not a browser one.

/* global importScripts, loadPyodide, self */

var PYODIDE_DIR = new URL("./pyodide/", self.location.href).href;
var WHEEL_URL = new URL("./cython-3.3.0-py3-none-any.whl", self.location.href).href;
var CYTHON_VERSION = "3.3.0";

var _ready = null;

function boot() {
  if (_ready) return _ready;
  _ready = (async function () {
    importScripts("./pyodide/pyodide.js");           // defines globalThis.loadPyodide
    var py = await loadPyodide({ indexURL: PYODIDE_DIR });
    var whl = new Uint8Array(await (await fetch(WHEEL_URL)).arrayBuffer());
    py.FS.writeFile("/cython-3.3.0-py3-none-any.whl", whl);
    py.runPython(
      "import sys\n" +
      "sys.path.insert(0, '/cython-3.3.0-py3-none-any.whl')\n" +
      "import Cython\n" +
      "assert Cython.__version__ == '" + CYTHON_VERSION + "', Cython.__version__\n"
    );
    return py;
  })();
  return _ready;
}

// The compile itself runs in Python so Cython's own diagnostics (which go
// to stderr) are captured, and any Python-level failure is reported as a
// string instead of tearing down the worker.
var COMPILE_PY = [
  "import io, contextlib, json, os",
  "from Cython.Compiler import Main, Options",
  "buf = io.StringIO()",
  "opts = Options.CompilationOptions(Options.default_options)",
  "opts.output_file = _cy_c",
  "n = None; err = None",
  "try:",
  "    with contextlib.redirect_stderr(buf), contextlib.redirect_stdout(buf):",
  "        result = Main.compile(_cy_src, options=opts)",
  "    n = result.num_errors",
  "except Exception as e:",
  "    n = -1",
  "    err = '%s: %s' % (type(e).__name__, e)",
  "c = open(_cy_c, encoding='utf-8', errors='replace').read() if os.path.exists(_cy_c) else ''",
  "json.dumps({'errors': n, 'err': err, 'log': buf.getvalue(), 'c': c, 'clines': (c.count(chr(10)) + 1) if c else 0})",
].join("\n");

self.onmessage = async function (e) {
  var m = e.data || {};
  try {
    if (m.type === "init") {
      await boot();
      self.postMessage({ type: "ready", version: CYTHON_VERSION });
      return;
    }
    if (m.type !== "job") return;
    var py = await boot();
    var ext = m.mode === "pyx" ? "pyx" : "py";
    var srcPath = "/tmp/py2cy_generated." + ext;
    var cPath = "/tmp/py2cy_generated.c";
    py.FS.writeFile(srcPath, String(m.source));
    py.globals.set("_cy_src", srcPath);
    py.globals.set("_cy_c", cPath);
    var out = JSON.parse(py.runPython(COMPILE_PY));
    self.postMessage({
      type: "done", jobId: m.jobId, ok: out.errors === 0,
      result: { errors: out.errors, err: out.err, log: out.log, c: out.c, clines: out.clines, version: CYTHON_VERSION },
    });
  } catch (err) {
    self.postMessage({ type: "done", jobId: m.jobId, ok: false, error: String((err && err.message) || err) });
  }
};
