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
// THREE REALMS, one engine:
//   • window   — the glue is a <script>, stdout goes through the
//                #mp_js_stdout DOM element (dispatchEvent('print')).
//   • worker   — the glue is loadScript'd (it is a classic script, so
//                importScripts is required, not `import`), stdout goes
//                through Module.onStdout (patched into the vendored
//                glue — see www/vendor/micropython.js's LOCAL PATCH).
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

// ─── Web Worker: importScripts the classic glue ─────────────────
// A module worker cannot call importScripts (illegal in module scope),
// but the glue is a classic script, so this must run in a classic worker.
// It exposes a worker-global `Module`, exactly as it does `window.Module`
// on the main thread.
async function loadGlueInWorker() {
  const base = glueWasmBase();
  const glueUrl = base + "micropython.js";
  try {
    self.importScripts(glueUrl);
  } catch (e) {
    throw new Error(
      "micropython in a worker needs a CLASSIC worker (importScripts is not available in a module worker): " + (e && e.message ? e.message : e));
  }
  const module = self.Module;
  if (!module || !module.cwrap) throw new Error("micropython glue did not expose Module");
  module.locateFile = module.locateFile || ((p) => base + p);
  return module;
}

async function loadGlueModule() {
  if (typeof document !== "undefined" && typeof window !== "undefined") return loadGlueInWindow();
  // WorkerGlobalScope: has importScripts/self, but no document.
  if (typeof importScripts === "function") return loadGlueInWorker();
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
  const isWorker = typeof document === "undefined" && typeof importScripts === "function";
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
