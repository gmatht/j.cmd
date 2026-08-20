// ─── __mime-time.mjs — time the transpiled mimecroft.js end-to-end ──
// Usage: node __mime-time.mjs /tmp/mimecroft-old.js
// Runs the generated JS against the real headless /dev/webgl device with
// a fixed key script; prints wall time of the game loop.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const js = readFileSync(process.argv[2] || "/tmp/mimecroft.js", "utf8");
const SH2GLSL = ["/home/llm/sh2loop/sh2perl/target/debug/sh2glsl", "/root/src/sh2loop/sh2perl/target/debug/sh2glsl"].filter((p) => existsSync(p))[0];

const KEY_SCRIPT = [
  "w,", "w,", "w,", "w,", "w,",
  "ArrowRight,", "w,", "w,", "w,",
  "ArrowLeft,", "space,", "space,", "space,", "space,", "space,",
  "w,", "w,", "w,", "w,", "w,", "w,", "w,", "w,", "w,", "w,",
  "q,",
];
let keyFrame = 0, sleepCount = 0;
const stdout = [];
const shellExec = async (cmdline) => {
  const cl = cmdline.trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") {
      const k = keyFrame < KEY_SCRIPT.length ? KEY_SCRIPT[keyFrame] : "q,";
      keyFrame++;
      out = k + "\n";
    } else { try { out = await fs.read(p); } catch (e) { out = ""; } }
  }
  else if (cmd === "sleep") {
    sleepCount++;
    if (sleepCount > 5000) throw new Error("test-stop");
    await new Promise((r) => setTimeout(r, 0));
  }
  else if (cmd === "sh2glsl" && SH2GLSL) {
    let r2 = rest;
    if (r2.startsWith("--view ")) r2 = r2.slice(r2.indexOf(" ") + 1);
    const vfsPath = r2.split(/\s+/)[0];
    const bashSrc = String(await fs.read(vfsPath));
    const dir = mkdtempSync(join(tmpdir(), "sh2glsl-"));
    const f = join(dir, "frag.sh");
    writeFileSync(f, bashSrc);
    try { out = execFileSync(SH2GLSL, [f], { encoding: "utf8" }); } catch (e) { out = ""; }
  }
  else if (cmd === "true") {}
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: { HOME: "/home", USER: "tinysh" }, shellExec, stdout: out, stderr: { write: (s) => stdout.push("[err] " + s) }, args: [], argv0: "bash" });

const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2",
  "return (async () => { " + js + " })();");
const t0 = process.hrtime.bigint();
try {
  await fn([], fs, { HOME: "/home" }, out, { write: () => {} }, shellExec, rt.sh2);
} catch (e) {
  if (e.message !== "test-stop") throw e;
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const log = await fs.read("/dev/webgl/log");
const draws = (log.match(/\[call\] draw /g) || []).length;
const hud = (log.match(/\[hud\] \d+ rects/g) || []).length;
console.log(`${process.argv[2]}  →  ${ms.toFixed(0)} ms  (${sleepCount} frames, ${draws} draws, ${hud} hud writes)`);
