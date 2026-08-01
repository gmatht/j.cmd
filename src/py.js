// ─── py: MicroPython engine (classic emscripten build) ──────────
//
// Drives the @yeliulee/micropython-wasm build (the official Rami Ali
// micropython.js) as a state-preserving engine — no worker, no
// SharedArrayBuffer, no COOP/COEP:
//
//   mp_js_init(size)          init the interpreter once (state persists)
//   mp_js_do_str(code)        run a string, async (asyncify), → exit code
//   mp_js_process_char(c)     feed one REPL char (returns 1 on EOF)
//
// One engine serves both modes: `python script.py` / `-c` / stdin via
// do_str, and the interactive REPL via per-line do_str (line-based, the
// same UX the SAB REPL had — but state now really persists).
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

// ─── browser: inject the glue as a <script>, then use Module.cwrap ─
async function loadGlueModule() {
  if (typeof document !== "undefined") {
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
// Output routing: in Node the glue writes straight to process.stdout
// (which the caller can capture by replacing it); in the browser it
// dispatches 'print' events on a #mp_js_stdout element — we create one
// and forward those events to the active writer.
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
  try {
    return await py.doStr(String(source));
  } catch (e) {
    err.write("python: " + (e && e.message ? e.message : String(e)) + "\n");
    return 1;
  } finally {
    currentOut = prevOut;
  }
}

// Backwards-compatible name (argv is not supported by this build).
export const pyRunStatic = pyExec;
