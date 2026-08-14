// ─── __crttest.mjs — verify CRT_ON/CORRUPT_ON strip the shader effects ──
// Runs the game's emit_fragment_shader setup with the toggles flipped and
// checks the generated GLSL (sh2glsl path) + the hand-written fallback.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const SH2GLSL_CANDIDATES = [
  process.env.SH2GLSL,
  "/home/llm/sh2loop/sh2perl/target/debug/sh2glsl",
  "/root/src/sh2loop/sh2perl/target/debug/sh2glsl",
].filter(Boolean);
const sh2glslBin = SH2GLSL_CANDIDATES.find((p) => existsSync(p));

async function runWith(src) {
  return runWithImpl(src, true);
}

async function runFallbackWith(src) {
  // sh2glsl returns "" → the game falls back to the hand-written fs_fb
  return runWithImpl(src, false);
}

async function runWithImpl(src, useSh2glsl) {
  let { js } = await bashToJS(fs, src);
  const shellExec = async (cmdline) => {
    const cl = cmdline.trim();
    const cmd = cl.split(/\s+/)[0];
    let rest = cl.slice(cmd.length).trim();
    if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
    let out = "";
    if (cmd === "echo") out = rest + "\n";
    else if (cmd === "cat") { try { out = await fs.read(rest.split(/\s+/)[0]); } catch { out = ""; } }
    else if (cmd === "sleep") { await new Promise((r) => setTimeout(r, 0)); }
    else if (cmd === "sh2glsl") {
      if (useSh2glsl && sh2glslBin) {
        // `--vertex` = the vertex stage (mimecroft-vertex.sh), else the
        // fragment stage (mimecroft-frag.sh)
        const vert = rest.startsWith("--vertex");
        const vfsPath = (vert ? rest.slice(8) : rest).trim().split(/\s+/)[0];
        const bashSrc = String(await fs.read(vfsPath));
        const dir = mkdtempSync(join(tmpdir(), "sh2glsl-"));
        const f = join(dir, vert ? "vert.sh" : "frag.sh");
        writeFileSync(f, bashSrc);
        try { out = execFileSync(sh2glslBin, [f], { encoding: "utf8" }); } catch { out = ""; }
      }
    }
    else if (cmd === "true") {}
    return { out, err: "", code: 0 };
  };
  const stdout = { write: () => {} };
  const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout, stderr: { write: () => {} }, args: [], argv0: "bash" });
  const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2",
    "return (async () => { " + js + " })();");
  await fn([], fs, { HOME: "/home" }, stdout, { write: () => {} }, shellExec, rt.sh2);
  return await fs.read("/dev/webgl/shader/fragment");
}

let base = readFileSync("examples/mimecroft.sh", "utf8");
// the shipped defaults are OFF — force the effects ON so the "allOn"
// runs exercise them (the OFF paths are the two replace lines below)
base = base.replace("CRT_ON=0", "CRT_ON=1");
base = base.replace("CORRUPT_ON=0", "CORRUPT_ON=1");
// strip the main() function + trailing call: run only the shader setup
base = base.slice(0, base.lastIndexOf("main() {")) + "setup_webgl\n";
// keep the frag temp file unique per run
base = base.replaceAll("/tmp/mimecroft-frag.sh", "/tmp/mimecroft-frag-crt.sh");

const allOn = await runWith(base);
const crtOff = await runWith(base.replace("CRT_ON=1", "CRT_ON=0"));
const corruptOff = await runWith(base.replace("CORRUPT_ON=1", "CORRUPT_ON=0"));
const bothOff = await runWith(base.replace("CRT_ON=1", "CRT_ON=0").replace("CORRUPT_ON=1", "CORRUPT_ON=0"));

console.log("── defaults ON ──");
console.log("  scanlines:", allOn.includes("g_scan"), "| corrupt:", allOn.includes("g_hash") && allOn.includes("g_corrupt"), "| vignette:", allOn.includes("g_edge"));
console.log("── CRT_ON=0 ──");
console.log("  scanlines:", crtOff.includes("g_scan"), "| corrupt:", crtOff.includes("g_hash") && crtOff.includes("g_corrupt"), "| vignette:", crtOff.includes("g_edge"));
console.log("── CORRUPT_ON=0 ──");
console.log("  scanlines:", corruptOff.includes("g_scan"), "| corrupt:", corruptOff.includes("g_hash") && corruptOff.includes("g_corrupt"), "| vignette:", corruptOff.includes("g_edge"));
console.log("── both OFF ──");
console.log("  scanlines:", bothOff.includes("g_scan"), "| corrupt:", bothOff.includes("g_hash") && bothOff.includes("g_corrupt"), "| vignette:", bothOff.includes("g_edge"));
const clean = !bothOff.includes("g_scan") && !bothOff.includes("g_hash") && !bothOff.includes("g_corrupt") && !bothOff.includes("g_edge");
const defaultsOk = allOn.includes("g_scan") && allOn.includes("g_hash") && allOn.includes("g_edge");
console.log(clean ? "PASS: both-off shader is clean" : "FAIL: effects still present with both off");
console.log(defaultsOk ? "PASS: defaults keep all effects" : "FAIL: defaults lost effects");

// ── hand-written fallback (sh2glsl unavailable) ──
const fbAll = await runFallbackWith(base);
const fbOff = await runFallbackWith(base.replace("CRT_ON=1", "CRT_ON=0").replace("CORRUPT_ON=1", "CORRUPT_ON=0"));
const fbOk = fbAll.includes("mod(gl_FragCoord.y, 6.0)") && fbAll.includes("97.0") && fbAll.includes("450.0");
const fbClean = !fbOff.includes("mod(gl_FragCoord.y, 6.0)") && !fbOff.includes("97.0") && !fbOff.includes("450.0") && fbOff.includes("gl_FragColor = vec4(c, 1.0)");
console.log("fallback defaults keep effects:", fbOk);
console.log("fallback both-off clean:", fbClean);
console.log((fbOk && fbClean) ? "PASS: fallback shader toggles work" : "FAIL: fallback shader toggles broken");
