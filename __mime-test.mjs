// ─── __mime-test.mjs — MIMEcroft.sh transpile-and-run harness ──────
// Reads www/bin/mimecroft.sh, transpiles it (bash → ESTree → JS) and
// runs the result against the REAL /dev/webgl device in its headless
// NullGL mode, with a stub shellExec (echo/cat/sleep/true) and a
// scripted key stream fed through /dev/webgl/key reads.
//
//   node __mime-test.mjs   → "ALL MIMECROFT CHECKS PASSED"
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1             # enabled for the mime tests");
// the shipped defaults are OFF; force them ON so the generated shader's
// CRT/corruption effects are exercised
src = src.replace("CRT_ON=0", "CRT_ON=1");
src = src.replace("CORRUPT_ON=0", "CORRUPT_ON=1");

// ─── transpile ────────────────────────────────────────────────────
let js;
try {
  ({ js } = await bashToJS(fs, src));
  console.log("TRANSPILE OK,", js.length, "chars of JS");
} catch (e) {
  console.log("TRANSPILE FAILED:", e.message);
  process.exit(1);
}

// ─── mini shellExec: echo, cat (key device), sleep, true, sh2glsl ─
// sh2glsl compiles the bash-authored fragment shader with the real
// Rust glsl_backend (sh2loop/sh2perl) — the game's runtime shader
// pipeline. Falls back to "" (→ the game's embedded shader) when the
// generator binary isn't available.
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
console.log("sh2glsl generator:", sh2glslBin ? "FOUND " + sh2glslBin : "not found (game falls back to embedded shader)");

const KEY_SCRIPT = [
  // frames 1.. — move forward into the maze
  "w,", "w,", "w,", "w,", "w,",
  // turn right, move on
  "ArrowRight,", "w,", "w,", "w,",
  // turn left, shoot a few times (mining)
  "ArrowLeft,", "space,", "space,", "space,", "space,", "space,",
  // walk home, idle, then quit
  "w,", "w,", "w,", "w,", "w,", "w,", "w,", "w,", "w,", "w,",
  "q,",
];
let keyFrame = 0, sleepCount = 0, echoCount = 0, catCount = 0;
const stdout = [];
const shellExec = async (cmdline, stdin) => {
  const cl = cmdline.trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") { echoCount++; out = rest + "\n"; }
  else if (cmd === "cat") {
    catCount++;
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") {
      const k = keyFrame < KEY_SCRIPT.length ? KEY_SCRIPT[keyFrame] : "q,";
      keyFrame++;
      out = k + "\n";
    } else {
      try { out = await fs.read(p); } catch (e) { out = ""; }
    }
  }
  else if (cmd === "sleep") {
    sleepCount++;
    if (sleepCount > 4000) throw new Error("test-stop");
    await new Promise((r) => setTimeout(r, 0));
  }
  else if (cmd === "bash") {
    // the game generates block textures at startup via
    // `bash texture-*.sh --tsv` — run them with HOST bash (the repo's
    // /examples maps to the working-dir examples/ for the host)
    const args = rest.split(/\s+/).map((a) => a.replace("/examples/", "examples/"));
    try { out = execFileSync("bash", args, { encoding: "utf8" }); } catch (e) { out = ""; }
  }
  else if (cmd === "sh2glsl") {

    // compile the bash-authored shader with the Rust backend
    // (`--view N` = the display width for pixel-space effects, `--vertex`
    // = the vertex stage, else the fragment)
    let v2 = rest;
    if (v2.startsWith("--view ")) v2 = v2.replace(/^--view\s+\S+\s*/, "");
    const vert = v2.startsWith("--vertex");
    const vfsPath = (vert ? v2.slice(8) : v2).trim().split(/\s+/)[0];
    const bashSrc = String(await fs.read(vfsPath));
    if (sh2glslBin) {
      const dir = mkdtempSync(join(tmpdir(), "sh2glsl-"));
      const f = join(dir, vert ? "vert.sh" : "frag.sh");
      writeFileSync(f, bashSrc);
      try {
        const args = vert ? ["--vertex", f] : [f];
        out = execFileSync(sh2glslBin, args, { encoding: "utf8" });
      } catch (e) {
        out = "";
      }
    }
  }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const err = { write: (s) => stdout.push("[err] " + s) };
// the current wasm lowers many `echo` calls to native `process.stdout.write`
// (bypassing the runtime's stdout sink) — capture those into the same text
// buffer the assertions scan.
{
  const ow = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s, ...rest) => { stdout.push(String(s)); return ow(s, ...rest); };
}
const rt = createSh2Runtime({
 fs, env: { HOME: "/home", USER: "tinysh" }, shellExec, stdout: out, stderr: err, args: [], argv0: "bash" });

// trace the last few runtime calls for error reports
const trace = [];
for (const k of ["setVar", "getVar", "param", "test", "arrayIndex", "setArray", "arithEval", "arith"]) {
  const orig = rt.sh2[k];
  rt.sh2[k] = (...a) => { trace.push(k + "(" + a.map((x) => String(x).slice(0, 40)).join(",") + ")"); if (trace.length > 40) trace.shift(); return orig(...a); };
}

// the current wasm lowers `keys=$(cat /dev/webgl/key)` to a DIRECT device
// read (`sh2.fs.readFile("/dev/webgl/key")`) instead of an exec — feed the
// scripted keys through the same bridge the browser's keyboard uses.
const origSh2ReadFile = rt.sh2.fs.readFile.bind(rt.sh2.fs);
rt.sh2.fs.readFile = async (p, enc) => {
  if (String(p) === "/dev/webgl/key") {
    const k = keyFrame < KEY_SCRIPT.length ? KEY_SCRIPT[keyFrame] : "q,";
    keyFrame++;
    return k;
  }
  return origSh2ReadFile(p, enc);
};

// ─── run ──────────────────────────────────────────────────────────
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2",
  "return (async () => { " + js + " })();");
try {
  await fn([], fs, { HOME: "/home" }, out, err, shellExec, rt.sh2);
} catch (e) {
  if (e.message !== "test-stop") {
    console.log("RUN ERROR:", e.message);
    for (const v of ["anim", "anim_t", "anim_steps", "anim_ayd", "ax0", "az0", "ay0", "ax1", "az1", "ay1", "px", "pz", "yaw", "dpyw_ms"]) {
      try { console.log("  store[" + v + "] =", JSON.stringify(rt.sh2.getVar(v))); } catch {}
    }
    console.log("last runtime calls:", JSON.stringify(trace, null, 1));
    console.log(e.stack.split("\n").slice(0, 8).join("\n"));
    process.exit(1);
  }
}
console.log("RAN OK (stopped by test-stop after", sleepCount, "sleeps)");

// ─── assertions ───────────────────────────────────────────────────
let fails = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log("PASS: " + name);
  else { fails++; console.log("FAIL: " + name + (extra ? "\n  " + extra : "")); }
};

const log = await fs.read("/dev/webgl/log");
check("shaders compiled (vertex+fragment)", log.includes("[shader/vertex]") && log.includes("[shader/fragment]"), log.split("\n").slice(-6).join("\n"));
check("program linked", log.includes("[program] linked OK"));
// the fragment shader is AUTHORED IN BASH and compiled by the sh→GLSL
// generator — prove the generated source is what the game loaded
const fragSrc = await fs.read("/dev/webgl/shader/fragment");
check("fragment shader is the textured one (generated)",
  fragSrc.includes("sampler2D uTex") && fragSrc.includes("g_tex_r") &&
  fragSrc.includes("texture2D(uTex"),
  fragSrc.slice(0, 160));
check("fragment shader keeps the CRT effects (generated)",
  fragSrc.includes("g_scan") && fragSrc.includes("g_corrupt") &&
  fragSrc.includes("g_edge") && fragSrc.includes("97") && fragSrc.includes("450"),
  fragSrc.slice(0, 240));
// the VERTEX shader is AUTHORED IN BASH too — compiled from
// /www/examples/mimecroft-vertex.sh by `sh2glsl --vertex` — prove the
// generated source is what the game loaded (the bash bridges + outputs)
const vertSrc = await fs.read("/dev/webgl/shader/vertex");
check("vertex shader is the generated one (bridges + outputs)",
  vertSrc.includes("attribute vec3 aPosition") &&
  vertSrc.includes("uniform float uCamYaw") &&
  vertSrc.includes("uniform float uCamShift") &&
  vertSrc.includes("g_ucy_m = int(uCamYaw * 1000.0)") &&
  vertSrc.includes("g_ucs = int(uCamShift * 1000.0)") &&
  vertSrc.includes("g_relx * (0.45)") &&
  vertSrc.includes("gl_Position = vec4(g_vp_x, g_vp_y, g_vp_z, g_vp_w)"),
  vertSrc.slice(0, 260));
check("vertex shader keeps the bc-trig rotation (cos/sin)",
  vertSrc.includes("cos(g_rad)") && vertSrc.includes("sin(g_rad)"),
  vertSrc.slice(0, 260));
check("vertex shader is highp (ES 1.00 requires it in vertex)",
  vertSrc.includes("precision highp float;") && !vertSrc.includes("precision mediump float"),
  vertSrc.slice(0, 80));
check("vertex shader eye sits at the CELL CENTRE (x/z unshifted — the old +0.5 put it on the corner and pushed one corridor wall off-screen)",
  vertSrc.includes("g_cx = ((((float(g_ucp_x)) / (1000.0))) + (0.0));") &&
  vertSrc.includes("g_cz = ((((float(g_ucp_z)) / (1000.0))) + (0.0));") &&
  vertSrc.includes("g_cy = ((((float(g_ucp_y)) / (1000.0))) + (0.5));"),
  vertSrc.split("\n").filter((l) => l.includes("g_c")).join(" | "));
check("cube UVs uploaded (aUv buffer)",
  log.includes("[buffer/aUv]"), "");
check("block textures uploaded to the device",
  (log.match(/\[texture\/\d+\] \d+x\d+ uploaded/g) || []).length >= 8, "");
check("MIME type textures uploaded (11=jpeg 12=png 13=octet 14=text)",
  [11, 12, 13, 14].every((n) =>
    log.includes("[texture/" + n + "] 64x64 uploaded")),
  log.split("\n").filter((l) => l.includes("texture/1")).slice(0, 6).join(" | "));
check("no MIME name tags on the HUD (labels removed, blips kept)",
  !log.includes("mime_label_pos") && /\[hud\] \d+ rects/.test(log),
  "");
check("uTex sampler written per block",
  (log.match(/\[uniform\/1i\/uTex\]/g) || []).length > 0, "");
const draws = (log.match(/\[call\] draw /g) || []).length;
check("draw calls happened", draws > 50, "draws=" + draws);
check("block colors written", /\[blocks\] \d+ cubes/.test(log), log.split("\n").filter((l) => l.includes("[blocks]")).join(" | "));
// clear/swap/hide update lastCall but are not logged (draw only)
const lastCall = (await fs.read("/dev/webgl/call")).trim();
check("hide called (game ended cleanly)", lastCall === "hide", "lastCall=" + JSON.stringify(lastCall));

const camRaw = (await fs.read("/dev/webgl/uniform/3f/uCamPos")).trim(); // "3f x y z"
const camParts = camRaw.split(/\s+/);
const camMoved = camParts.length === 4 && (camParts[1] !== "2" || camParts[3] !== "2");
check("camera moved from spawn (2,0,2)", camMoved, "uCamPos=" + camRaw);

const yawRaw = (await fs.read("/dev/webgl/uniform/1f/uCamYaw")).trim(); // "1f N"
check("uCamYaw written (0/90/180/270)", /^1f (0|90|180|270)$/.test(yawRaw), "yaw=" + yawRaw);

const obj = await fs.read("/dev/webgl/uniform/3f/uObjPos");
check("block positions written", /\d+ \S+ \d+/.test(obj.trim()), obj.trim());

const text = stdout.join("");
// the dashboard lives on the 3D canvas — the terminal shows only the
// banner + action messages (no map), verified by the batched /dev/webgl/hud
const hudWrites = (log.match(/\[hud\] \d+ rects/g) || []).map((l) => Number(/(\d+) rects/.exec(l)[1]));
check("canvas HUD drawn (batched overlay)", hudWrites.length > 0 && Math.max(...hudWrites) > 100, "hud writes=" + hudWrites.length);
const mapRows = (text.match(/\n  [#@!?.]+/g) || []).length;
check("minimap printed at most once (then the canvas takes over)", mapRows <= 16, "map rows=" + mapRows);
check("no per-frame HUD spam in the terminal", (text.match(/MIMEcroft\s+artifacts/g) || []).length <= 1, "infobar prints=" + (text.match(/MIMEcroft\s+artifacts/g) || []).length);
check("mimes drawn (batched world draws)", /\[blocks\] \d+ cubes/.test(log), "");
check("no unknown commands in output", !/command not found/.test(text), text.split("\n").find((l) => /command not found/.test(l)) || "");
check("game-over line printed", /GAME DONE|GAME OVER|VICTORY|Quit/.test(text));
const scoreLine = text.match(/Score[^\n]*/g);
console.log("score lines:", JSON.stringify(scoreLine ? scoreLine.slice(-3) : []));
console.log("hud sample:", JSON.stringify(stdout.find((l) => /^MIMEcroft /.test(l))));
console.log("log tail:", JSON.stringify(log.split("\n").slice(-4)));

if (fails) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
console.log("\nALL MIMECROFT CHECKS PASSED");
