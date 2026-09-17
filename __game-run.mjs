// ─── __game-run.mjs — run the transpiled game headless to completion ──
// Transpiles www/bin/mimecroft.sh with the project's own pipeline, runs
// it against the sh2 runtime with REAL sh2glsl (otranspilerl wasm) and
// a "q" key pre-loaded in the /dev/webgl device queue. PASS = the game
// starts, compiles shaders, renders, and quits on q without unhandled
// errors. (The device's _keys are read directly by the game via
// fs.read("/dev/webgl/key") — shellExec mocks never see them.)
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

let src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const stdout = [];
let shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") { try { out = await fs.read(fs._resolve(rest.split(/\s+/)[0])); } catch { out = ""; } }
  else if (cmd === "sleep") { await new Promise(r => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") {
    const m = cl.match(/^sh2glsl\s+(--vertex\s+)?(\S+)/);
    if (m) {
      const vert = !!m[1];
      try {
        const srcTxt = String(await fs.read(fs._resolve(m[2])));
        const { getOtranspilerl } = await import("./src/otranspilerl.js");
        const lib = await getOtranspilerl();
        out = vert ? lib.glslv(srcTxt) : lib.glsl(srcTxt);
      } catch { out = ""; }
    }
  }
  else if (cmd === "bash") { out = "  fake-tex-tsv\n"; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
let webglDev = null;
for (const m of Object.values(fs.mounts || {})) {
  const b = m && m.backend;
  if (b && b._webgl) { webglDev = b._webgl; break; }
}
webglDev._keys = ["q"];
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
let failed = null;
try {
  await Promise.race([
    fn([], fs, { HOME: "/home" }, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2),
    new Promise((res) => setTimeout(() => { failed = "TIMEOUT (game did not quit on q)"; res(); }, 90000)),
  ]);
} catch (e) { failed = e.message; }
const errs = stdout.filter((s) => String(s).includes("undefined") || String(s).includes("FAILED"));
const prog = webglDev._programStatus ? webglDev._programStatus() : "?";
if (failed) { console.log("FAIL:", failed); process.exit(1); }
if (errs.length) { console.log("FAIL — device errors:", JSON.stringify(errs.slice(0, 3))); process.exit(1); }
if (!/linked/.test(prog)) { console.log("FAIL — program not linked:", prog); process.exit(1); }
console.log("PASS — game ran to completion; program:", prog.trim().split("\n")[0]);
