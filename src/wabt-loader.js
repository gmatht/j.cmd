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
 * Convert WAT text to a WASM binary (Uint8Array).
 * Throws an Error with the WAT diagnostics on failure.
 */
export async function watToWasm(watText, name = "module.wat") {
  const wabt = await loadWabt();
  const module = wabt.parseWat(name, watText);
  const { buffer } = module.toBinary({ log: false, write_debug_names: false });
  module.destroy();
  return new Uint8Array(buffer);
}
