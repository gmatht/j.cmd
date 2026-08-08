// ─── realbash: the REAL bash 5.3 (wasm32-emscripten) ───────────
//
// www/wasm-bin/bash.wasm + www/vendor/bash.js — the actual bash
// binary (bahamas10/bash-wasm build), the same one the otranspiler
// GUI runs. The shell's bare `bash` builtin TRANSPILES bash → JS and
// runs it against the sh2.* runtime; `/bin/bash` is this real binary
// (full bash: printf/[[/arrays/…, no transpile). Both shells call
// runRealBash() for the explicit `/bin/bash` path.
//
// Note: bash.wasm has its OWN emscripten filesystem — the script
// text is written into it; the script's file operations (cat /home/…)
// see bash's sandbox, not the shell's VirtualFS.
// -----------------------------------------------------------------

// The emscripten MODULARIZE factory: browser fetches vendor/bash.js
// relative to the page; node imports the repo copy from disk.
async function bashFactory() {
  if (typeof document !== "undefined") {
    return (await import(new URL("vendor/bash.js", import.meta.url).href)).default;
  }
  return (await import(new URL("../www/vendor/bash.js", import.meta.url).href)).default;
}

function wasmUrl(p) {
  if (typeof document !== "undefined") {
    return new URL("wasm-bin/" + p, import.meta.url).href;
  }
  return new URL("../www/wasm-bin/" + p, import.meta.url).pathname;
}

// Run a bash script through the REAL bash binary. Returns
// { out, err, code } (syscall warnings filtered from err).
export async function runRealBash(script) {
  const factory = await bashFactory();
  let out = "", err = "";
  const m = await factory({
    noInitialRun: true,
    locateFile: wasmUrl,
    print: (t) => { out += t + "\n"; },
    printErr: (t) => { err += t + "\n"; },
  });
  m.FS.writeFile("/script.sh", String(script));
  let code = 0;
  try {
    m.callMain(["/script.sh"]);
  } catch (e) {
    code = (e && e.exitStatus) || (e && e.status) || 1;
  }
  // emscripten's runtime notices are noise — drop them (the real bash
  // output is in stdout; these are just exit/flush chatter).
  err = err.split("\n").filter((l) =>
    !/^warning: unsupported syscall/.test(l) &&
    !/^program exited \(with status/.test(l) &&
    !/^warning: stdio streams had content/.test(l)
  ).join("\n");
  return { out, err, code };
}
