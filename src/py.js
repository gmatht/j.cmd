// ─── py: MicroPython engine (classic emscripten build) ──────────
//
// Drives the @yeliulee/micropython-wasm build (the official Rami Ali
// micropython.js) as a state-preserving engine — no SharedArrayBuffer,
// no COOP/COEP:
//
//   mp_js_init(size)          init the interpreter once (state persists)
//   mp_js_do_str(code)        run a string, async (asyncify), → exit code
//   mp_js_process_char(c)     feed one REPL char (returns 1 on EOF)
//
// One engine serves both modes: `python script.py` / `-c` / stdin via
// do_str, and the interactive REPL via per-line do_str (line-based, the
// same UX the SAB REPL had — but state now really persists).
//
// FOUR REALMS, one engine:
//   • window   — the glue is a <script>, stdout goes through the
//                #mp_js_stdout DOM element (dispatchEvent('print')).
//   • CLASSIC worker — the glue is importScripts'd (it is a classic
//                script, so importScripts is required, not `import`),
//                stdout goes through Module.onStdout (patched into the
//                vendored glue — see www/vendor/micropython.js's LOCAL
//                PATCH).
//   • MODULE worker — NO engine: see loadGlueModule(). A module worker
//                cannot host this glue (importScripts is illegal there,
//                and `var Module` from an imported module never reaches
//                self.Module), so module-worker callers must go through
//                the classic www/vendor/py-worker.js bridge below —
//                exactly what the otranspiler stage workers do.
//   • Node CLI — require() the npm glue; stdout is process.stdout.
// -----------------------------------------------------------------

const WASM_NAME = "micropython.wasm";

let engine = null;  // { doStr, feedChar, module }
let loadPromise = null;

export function getPyEngine() {
  loadPromise ??= loadEngine();
  return loadPromise;
}

async function loadEngine() {
  const module = await loadGlueModule();
  await waitInitialized(module);
  const size = 4 * 1024 * 1024;
  module.cwrap("mp_js_init", "null", ["number"])(size);
  const doStr = module.cwrap("mp_js_do_str", "number", ["string"], { async: true });
  const feedChar = module.cwrap("mp_js_process_char", "number", ["number"]);
  return { module, doStr, feedChar };
}

function waitInitialized(module) {
  if (module.onRuntimeInitialized) {
    return new Promise((resolve) => {
      const orig = module.onRuntimeInitialized;
      module.onRuntimeInitialized = () => { orig(); resolve(); };
    });
  }
  // Already initialized (or the glue set it synchronously).
  return Promise.resolve();
}

// The glue resolves its wasm path at EVALUATION time (`locateFile`, and
// the worker branch uses self.location), so the script's own directory is
// the reliable base — same-directory resolution is how the vendored glue
// was laid out (micropython.js + micropython.wasm together).
function glueWasmBase() {
  try {
    // import.meta.url is this module's own URL (…/src/py.js), so the
    // vendored glue is a fixed ../www/vendor/ away — in every realm.
    return new URL("../www/vendor/", import.meta.url).href;
  } catch {
    return "vendor/";
  }
}

// ─── browser window: inject the glue as a <script> ──────────────
async function loadGlueInWindow() {
  const src = "vendor/micropython.js";
  const existing = document.querySelector('script[src="' + src + '"]');
  if (!existing) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  }
  const module = window.Module;  // emscripten module singleton
  if (!module || !module.cwrap) throw new Error("micropython glue did not expose Module");
  // Point the glue at the wasm next to the script (it fetches it itself).
  module.locateFile = module.locateFile || ((p) => "vendor/" + p);
  return module;
}

// ─── which realm are we in? ─────────────────────────────────────
// `typeof importScripts` is USELESS as a probe: Chromium defines it in
// module workers too — only CALLING it throws ("Module scripts don't
// support importScripts()"). Verified in this repo's chromium:
//
//              typeof importScripts   importScripts()   dynamic import()
//   module     "function"             throws           works
//   classic    "function"             works            works
//
// So realm detection is BEHAVIOURAL. Two independent questions:
//   isClassicWorker()  — may we importScripts the glue?
//   hasGlueGlobal()    — did the glue's bare `var Module` land somewhere
//                        we can see? (module scope → self.Module stays
//                        undefined, which is fatal for the engine)
function isClassicWorker() {
  if (typeof WorkerGlobalScope === "undefined") return false;
  try {
    importScripts("data:text/javascript,");
    return true;
  } catch {
    return false;   // module worker: "Module scripts don't support importScripts()"
  }
}

function hasGlueGlobal() {
  if (typeof self === "undefined" || !self) return false;
  const m = self.Module;
  return !!(m && typeof m.cwrap === "function");
}

// A module worker is FATAL for this engine and we must say so instead of
// throwing the raw emscripten TypeError:
//   • importScripts() throws in module scope ("Module scripts don't
//     support importScripts()");
//   • a dynamic import() of the glue DOES evaluate it, but `var Module`
//     then lives in MODULE scope — self.Module stays undefined.
// Module workers must run Python through the classic worker bridge
// (www/vendor/py-worker.js) — see pyExecInClassicWorker below.
const CLASSIC_WORKER_HINT =
  "the Python engine (micropython) is a classic emscripten script: it needs a CLASSIC worker " +
  "(importScripts throws in a module worker, and the glue's `var Module` never reaches " +
  "self.Module through import()). Run python via www/vendor/py-worker.js instead.";

// Load the glue in a WORKER, trying the classic importScripts path first
// and falling back to dynamic import() (which at least evaluates the
// script) — with a clear diagnostic when neither can expose Module.
async function loadGlueInWorkerAsync() {
  const base = glueWasmBase();
  const glueUrl = base + "micropython.js";
  const failures = [];
  if (isClassicWorker()) {
    try {
      importScripts(glueUrl);
      if (hasGlueGlobal()) return finishGlue(self.Module, base);
      failures.push("importScripts() ran but self.Module was not exposed");
    } catch (e) {
      failures.push("importScripts(): " + (e && e.message ? e.message : e));
    }
  } else {
    failures.push("importScripts() is unavailable (module worker)");
  }
  // Fallback: evaluate the glue as a module. `var Module` lands in module
  // scope, so this only works if the glue ever adopts an existing global
  // Module (self.Module) — otherwise it is undetectable from here and we
  // report the real reason instead of a bare TypeError.
  const hadGlobal = hasGlueGlobal();
  try {
    await import(glueUrl);
  } catch (e) {
    failures.push("import(): " + (e && e.message ? e.message : e));
  }
  if (hasGlueGlobal()) return finishGlue(self.Module, base);
  if (hadGlobal) failures.push("a self.Module existed but was not adopted");
  throw new Error(CLASSIC_WORKER_HINT + " [" + failures.join("; ") + "]");
}

function finishGlue(module, base) {
  module.locateFile = module.locateFile || ((p) => base + p);
  return module;
}

async function loadGlueModule() {
  if (typeof document !== "undefined" && typeof window !== "undefined") return loadGlueInWindow();
  // Worker realm (WorkerGlobalScope): classic importScripts, else the
  // module-worker path with a clear error. NOTE: a module worker DOES
  // define importScripts (it throws only when called), so this cannot be
  // a `typeof` test.
  if (typeof WorkerGlobalScope !== "undefined") return loadGlueInWorkerAsync();
  // ─── Node (CLI): require the glue with a fetch shim for the wasm ─
  const { createRequire } = await import("node:module");
  const path = await import("node:path");
  const require2 = createRequire(import.meta.url);
  const gluePath = require2.resolve("@yeliulee/micropython-wasm/lib/micropython.js");
  const wasmPath = path.join(path.dirname(gluePath), WASM_NAME);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes(WASM_NAME)) {
      const { readFileSync } = await import("node:fs");
      return new Response(readFileSync(wasmPath), {
        status: 200,
        headers: { "content-type": "application/wasm" },
      });
    }
    return realFetch(url, opts);
  };
  try {
    return require2(gluePath);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ─── static / REPL execution ───────────────────────────────────
// Runs `source` in the persistent interpreter. Note: this classic build
// exposes sys.argv as a read-only empty list, so script args are not
// populated (documented limitation). Returns the exit code.
//
// Output routing:
//   • Node    — the glue writes straight to process.stdout (the caller
//               captures it by replacing process.stdout);
//   • window  — 'print' events on the #mp_js_stdout element;
//   • worker  — Module.onStdout (the vendored-glue patch), because a
//               worker has no document to dispatch events on.
let currentOut = null;

function ensureStdoutElement() {
  if (typeof document === "undefined") return;
  let el = document.getElementById("mp_js_stdout");
  if (!el) {
    el = document.createElement("div");
    el.id = "mp_js_stdout";
    el.style.display = "none";
    document.body.appendChild(el);
  }
  if (!el.__pyHooked) {
    el.__pyHooked = true;
    el.addEventListener("print", (e) => {
      if (currentOut && e.data) currentOut.write(String(e.data));
    });
  }
}

export async function pyExec(source, { stdout, stderr } = {}) {
  const py = await getPyEngine();
  ensureStdoutElement();
  const prevOut = currentOut;
  const out = stdout || { write: () => {} };
  const err = stderr || out;
  currentOut = out;
  // worker realm: route the glue's chars to this call's writer. (The DOM
  // realm uses the element listener above; Node uses process.stdout.)
  // Same behavioural test as the loader — a module worker also defines
  // importScripts, so `typeof` would misroute stdout to a dead hook.
  const isWorker = typeof WorkerGlobalScope !== "undefined" && isClassicWorker();
  const prevHook = isWorker ? py.module.onStdout : undefined;
  if (isWorker) py.module.onStdout = (c) => out.write(String(c));
  try {
    return await py.doStr(String(source));
  } catch (e) {
    err.write("python: " + (e && e.message ? e.message : String(e)) + "\n");
    return 1;
  } finally {
    currentOut = prevOut;
    if (isWorker) py.module.onStdout = prevHook;
  }
}

// Backwards-compatible name (argv is not supported by this build).
export const pyRunStatic = pyExec;

// ─── classic-worker bridge (for MODULE-worker callers) ──────────
// A module worker cannot host the micropython glue at all (see
// isClassicWorker above), so module-worker callers — the otranspiler
// stage workers (www/otranspile-job.js → src/otranspile-jobs.js) and
// anything else running as `{ type: "module" }` — MUST run python in a
// nested CLASSIC worker (www/vendor/py-worker.js) and bridge its
// postMessage protocol back to a promise. This is the same worker the
// auto_cython page uses for its "run python" stage; here it is wrapped
// so callers that already live in a worker keep the pyExec signature.
//
// The nested worker is lazy (nothing loads until the first run), is
// reused across runs (state persists in the interpreter, matching
// pyExec), and is torn down on a crash so the next call gets a fresh
// engine rather than a wedged one.

const PY_WORKER_PROTOCOL_MS = 600000;   // hard cap per run (10 min)
let classicWorker = null;               // the nested Worker
let classicSeq = 1;
let classicChain = Promise.resolve();   // one job at a time (asyncify)

// Resolve the nested worker URL. `base` is the www/ base URL when the
// caller has one (the page passes it into the stage workers as
// ctx.wwwBase); the default derives …/www/ from this module's own URL,
// which is right for the served layout (/j.cmd/src/py.js → /j.cmd/www/)
// and for Node.
export function classicPyWorkerUrl(base) {
  try {
    return new URL("vendor/py-worker.js", base || new URL("../www/", import.meta.url)).href;
  } catch {
    return "vendor/py-worker.js";
  }
}

function terminateClassicPyWorker() {
  if (classicWorker) { try { classicWorker.terminate(); } catch {} }
  classicWorker = null;
}

function runInClassicPyWorker(source, { stdout, stderr, base } = {}) {
  return new Promise((resolve) => {
    let worker = classicWorker;
    if (!worker) {
      worker = new Worker(classicPyWorkerUrl(base));
      classicWorker = worker;
    }
    const jobId = classicSeq++;
    let done = false;
    const finish = (rec) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      worker.removeEventListener("message", onMsg);
      worker.removeEventListener("error", onErr);
      resolve(rec);
    };
    const onMsg = (e) => {
      const m = e.data || {};
      if (m.jobId !== jobId) return;               // status notes carry the id too
      if (m.type === "status") return;
      if (m.type !== "done") return;
      if (m.ok) {
        const r = m.result || {};
        if (r.out && stdout) stdout.write(r.out);
        if (r.err && stderr) stderr.write(r.err);
        finish({ code: r.code == null ? 0 : r.code, out: r.out || "", err: r.err || "" });
      } else {
        const msg = String(m.error || "python worker failed");
        if (stderr) stderr.write(msg + "\n");
        finish({ code: 1, out: "", err: msg, error: msg });
      }
    };
    const onErr = (e) => {
      // A crashed worker must not be reused: the next call respawns a
      // fresh engine (the old one may hold a half-initialized wasm).
      if (classicWorker === worker) terminateClassicPyWorker();
      const msg = (e && e.message) || "python worker crashed";
      if (stderr) stderr.write(msg + "\n");
      finish({ code: 1, out: "", err: msg, error: msg });
    };
    const to = setTimeout(() => {
      if (classicWorker === worker) terminateClassicPyWorker();
      const msg = "python: timed out after " + Math.round(PY_WORKER_PROTOCOL_MS / 1000) + "s";
      if (stderr) stderr.write(msg + "\n");
      finish({ code: 1, out: "", err: msg, error: msg });
    }, PY_WORKER_PROTOCOL_MS);
    worker.addEventListener("message", onMsg);
    worker.addEventListener("error", onErr);
    worker.postMessage({ type: "job", jobId, source: String(source) });
  });
}

// Exported for callers that must decide whether the engine can run
// in-realm or has to be bridged to a nested classic worker (see
// src/otranspile-jobs.js's runPy, which uses this for exactly that).
export { isClassicWorker };

// pyExec-compatible entry point that always runs in a classic worker.
// Module-worker callers use this via runPy (src/otranspile-jobs.js):
// pyExec itself stays synchronous-in-realm and throws the clear
// CLASSIC_WORKER_HINT there instead of the raw emscripten TypeError.
export function pyExecInClassicWorker(source, opts = {}) {
  const rec = runInClassicPyWorker(source, opts);
  classicChain = classicChain.then(() => rec, () => rec);
  return rec.then((r) => r.code);
}

