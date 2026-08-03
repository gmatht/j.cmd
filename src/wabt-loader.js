// ─── wabt-loader.js ─────────────────────────────────────────────
// Loads the WABT toolkit (wat2wasm) in both Node and the browser.
//
// wabt's npm package ships as a UMD bundle (CommonJS). Browsers can't
// import CJS directly, so we fetch the source and evaluate it with a
// fake module/exports context, then call the factory to get the API.
// -----------------------------------------------------------------

let cache = null;

export async function loadWabt() {
  if (cache) return cache;

  let WabtModule;

  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    // Node: native CJS interop via import()
    const mod = await import("wabt");
    WabtModule = mod.default || mod;
  } else {
    // Browser: fetch the UMD bundle relative to this module and eval it
    const url = new URL("../node_modules/wabt/index.js", import.meta.url).href;
    const src = await (await fetch(url)).text();
    const fakeModule = { exports: {} };
    const fn = new Function("module", "exports", "require", src);
    fn(fakeModule, fakeModule.exports, () => {
      throw new Error("require() is not available in the browser");
    });
    WabtModule = fakeModule.exports.default || fakeModule.exports;
  }

  cache = await WabtModule();
  return cache;
}

/**
 * Convert old-style WAT opcodes to modern syntax that wabt accepts.
 * Some older C→WASM compilers emitted legacy opcode spellings:
 *   get_global → global.get, set_global → global.set
 *   (also handles get_local/set_local just in case)
 */
export function normalizeWat(watText) {
  return watText
    .replace(/get_global\b/g, "global.get")
    .replace(/set_global\b/g, "global.set")
    .replace(/get_local\b/g, "local.get")
    .replace(/set_local\b/g, "local.set");
}

/**
 * Convert WAT text to a WASM binary (Uint8Array).
 * Throws an Error with the WAT diagnostics on failure.
 */
export async function watToWasm(watText, name = "module.wat") {
  const wabt = await loadWabt();
  const normalized = normalizeWat(watText);
  const module = wabt.parseWat(name, normalized);
  const { buffer } = module.toBinary({ log: false, write_debug_names: false });
  module.destroy();
  return new Uint8Array(buffer);
}
