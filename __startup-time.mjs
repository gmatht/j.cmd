// ─── __startup-time.mjs — time mimecroft STARTUP (banner → "ready.") ──
// Uses the real headless /dev/webgl device with a stub shellExec; stops
// the moment stdout contains "ready." (startup complete). Prints the
// wall time and the sequence of startup messages.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

let src = readFileSync("www/bin/mimecroft.sh", "utf8");
let js;
try {
  ({ js } = await bashToJS(fs, src));
} catch (e) {
  console.log("TRANSPILE FAILED:", e.message);
  process.exit(1);
}

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

let sleepCount = 0, echoCount = 0, writeCount = 0;
const stdout = [];
const shellExec = async (cmdline) => {
  const cl = cmdline.trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") { echoCount++; out = rest + "\n"; }
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    try { out = await fs.read(p); } catch (e) { out = ""; }
  }
  else if (cmd === "sleep") {
    sleepCount++;
    await new Promise((r) => setTimeout(r, 0));
  }
  else if (cmd === "bash") {
    const args = rest.split(/\s+/).map((a) => a.replace("/examples/", "examples/"));
    try { out = execFileSync("bash", args, { encoding: "utf8" }); } catch (e) { out = ""; }
  }
  else if (cmd === "sh2glsl") {
    const vfsPath = rest.split(/\s+/)[0];
    const bashSrc = String(await fs.read(vfsPath));
    if (sh2glslBin) {
      const dir = mkdtempSync(join(tmpdir(), "sh2glsl-"));
      const f = join(dir, "frag.sh");
      writeFileSync(f, bashSrc);
      try { out = execFileSync(sh2glslBin, [f], { encoding: "utf8" }); } catch (e) { out = ""; }
    }
  }
  else if (cmd === "true") {}
  return { out, err: "", code: 0 };
};
const out = { write: (s) => { stdout.push(s); writeCount++; if (s.includes("ready.")) throw new Error("startup-done"); } };
const err = { write: () => {} };
const rt = createSh2Runtime({ fs, env: { HOME: "/home", USER: "tinysh" }, shellExec, stdout: out, stderr: err, args: [], argv0: "bash" });

const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2",
  "return (async () => { " + js + " })();");
const t0 = process.hrtime.bigint();
try {
  await fn([], fs, { HOME: "/home" }, out, err, shellExec, rt.sh2);
} catch (e) {
  if (e.message !== "startup-done") { console.log("RUN ERROR:", e.message); process.exit(1); }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`\nSTARTUP complete in ${ms.toFixed(0)} ms`);
console.log("startup messages in order:");
for (const s of stdout) console.log(JSON.stringify(s));
