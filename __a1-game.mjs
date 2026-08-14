import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
import { estreeToJs, keepVariables } from "./src/estree.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("examples/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0", "MIMES_ON=1");
src = src.replace("*headless*) sound=$((0)); headless=$((0)) ;;", "*headless*) sound=$((0)); headless=$((1)) ;;");
const lib = await getOtranspilerl();
const program = JSON.parse(lib.transpile(src, "sh", "js"));
const a1 = JSON.parse(lib.shir(src));
const scriptArrays = [];
const arrayVals = new Map();
function a1LiteralValue(expr) {
  if (!expr) return null;
  if (expr.type === "Array") return expr.elements.map(a1LiteralValue);
  if (expr.type === "Str") return expr.value;
  return null;
}
for (const st of a1.stmts || []) {
  if (st && st.type === "Assign" && st.targets && st.targets[0]) {
    const t = st.targets[0];
    if (t.var && !(t.indices && t.indices.length)) {
      const val = a1LiteralValue(st.expr);
      if (Array.isArray(val)) { scriptArrays.push(t.var); arrayVals.set(t.var, val); }
    }
  }
}
keepVariables(program, scriptArrays);
const js = await estreeToJs(program);
const KEYS = ["w,", "ArrowRight,", "w,", "space,", "w,", "w,", "q,"];
let keyFrame = 0, sleepCount = 0;
const stdout = [];
const shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") { out = (keyFrame < KEYS.length ? KEYS[keyFrame] : "q,") + "\n"; keyFrame++; }
    else { try { out = await fs.read(p); } catch { out = ""; } }
  }
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 1200) throw new Error("test-stop"); await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") { out = ""; }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });
for (const [name, vals] of arrayVals) { try { rt.sh2.setArray(name, vals); } catch {} }
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
const t0 = Date.now();
const periodic = setInterval(async () => {
  try {
    const log = await fs.read("/dev/webgl/log");
    const c = (log.match(/draw elements triangles count=36/g) || []).length;
    const h = (log.match(/\[hud\] \d+ rects/g) || []).length;
    console.error("PROGRESS:", Date.now()-t0, "ms | cubes:", c, "| hud frames:", h);
  } catch {}
}, 15000);
const watchdog = setTimeout(() => { console.error("WATCHDOG — reading log anyway"); }, 250000);
try { await fn([], fs, {}, out, { write: (s) => stdout.push("[err] " + s) }, shellExec, rt.sh2); }
catch (e) { if (e.message !== "test-stop") console.log("RUN ERROR:", e.message); }
clearTimeout(watchdog); clearInterval(periodic);
const dt = Date.now() - t0;
const log = await fs.read("/dev/webgl/log");
const cubes = (log.match(/draw elements triangles count=36/g) || []).length;
const errLines = stdout.filter((l) => l.includes("[err]") || /command not found/.test(l)).length;
console.log("A1-path game:", dt + "ms", "| cube draws:", cubes, "| errors:", errLines);
console.log(cubes > 500 && errLines === 0 ? "A1 GAME: PASS" : "A1 GAME: FAIL");
