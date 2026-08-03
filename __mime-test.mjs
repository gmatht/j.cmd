import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

const src = readFileSync("/tmp/mimecroft.sh", "utf8");
// transpile
let js;
try {
  ({ js } = await bashToJS(fs, src));
  console.log("TRANSPILE OK,", js.length, "chars of JS");
} catch (e) {
  console.log("TRANSPILE FAILED:", e.message);
  process.exit(1);
}

// mini shellExec: echo, cat (key device), sleep, true
let sleepCount = 0, keyFrame = 0, echoCount = 0;
const stdout = [];
const shellExec = async (cmdline, stdin) => {
  // Minimal tokenizer (the real shell does full POSIX quoting; the game
  // only uses echo/cat/sleep, whose args the runtime quoteWords).
  const cl = cmdline.trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") { out = rest + "\n"; }
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") {
      keyFrame++;
      out = keyFrame <= 8 ? "w,ArrowLeft,space,\n" : "space,\n";  // move, then keep shooting
    } else {
      try { out = await fs.read(p); } catch (e) { out = ""; }
    }
  }
  else if (cmd === "sleep") { sleepCount++; if (sleepCount > 2000) throw new Error("test-stop"); if (sleepCount % 200 === 0) console.log("...", sleepCount, "sleeps"); await new Promise((r) => setTimeout(r, 1)); }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const err = { write: (s) => stdout.push("[err] " + s) };
const rt = createSh2Runtime({ fs, env: { HOME: "/home", USER: "tinysh" }, shellExec, stdout: out, stderr: err, args: [], argv0: "bash" });
// trace the last few runtime calls
const trace = [];
for (const k of ["setVar", "getVar", "param", "test", "arrayIndex", "setArray", "arithEval"]) {
  const orig = rt.sh2[k];
  rt.sh2[k] = (...a) => { trace.push(k + "(" + a.map((x) => String(x).slice(0, 40)).join(",") + ")"); if (trace.length > 8) trace.shift(); return orig(...a); };
}
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2",
  "return (async () => { " + js + " })();");
try {
  await fn([], fs, { HOME: "/home" }, out, err, shellExec, rt.sh2);
} catch (e) {
  if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); console.log("last calls:", JSON.stringify(trace, null, 1)); console.log(e.stack.split("\n").slice(0, 5).join("\n")); process.exit(1); }
}
console.log("RAN OK (stopped by test-stop after", sleepCount, "sleeps)");
console.log("score lines:", JSON.stringify(stdout.filter((l) => l.startsWith("+") || l.includes("GAME") || l.includes("score")).slice(0, 12)));
console.log("stdout lines:", stdout.length, "| first:", JSON.stringify(stdout[0]));
// key checks
const cam = await fs.read("/dev/webgl/uniform/3f/uCamPos");
console.log("uCamPos after game:", cam.trim(), "(start 1500 500 1500)");
const log = await fs.read("/dev/webgl/log");
console.log("shaders compiled:", log.includes("shader/vertex") && log.includes("shader/fragment"));
const state = await fs.read("/dev/webgl/state");
// count popped walls: the map is in the script; check /dev/webgl/uniform writes instead
const log2 = await fs.read("/dev/webgl/log");
console.log("draw calls in log:", (log2.match(/draw /g) || []).length);
console.log("clear calls:", (log2.match(/\[call\] clear/g) || []).length);
console.log("log tail:", JSON.stringify(log2.split("\n").slice(-4)));
try { const obj = await fs.read("/dev/webgl/uniform/3f/uObjPos"); console.log("last uObjPos:", obj.trim()); }
catch { console.log("uObjPos never written"); }
try { const lc = await fs.read("/dev/webgl/call"); console.log("last call:", JSON.stringify(lc.trim())); } catch (e) {}
try { const bind = await fs.read("/dev/webgl/bind"); console.log("bindings:", bind.trim()); }
catch (e) { console.log("bind read:", e.message); }
console.log("context:", state.split("\n")[0]);
console.log("buffers:", (state.match(/cube:/) || ["none"])[0]);
// post-game map check
