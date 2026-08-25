import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
const SH2GLSL = ["/home/llm/sh2loop/sh2perl/target/debug/sh2glsl"].find((p) => existsSync(p));
const shellExec = async (cmdline, stdin) => {
  const cl = cmdline.trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") { try { out = await fs.read(rest.split(/\s+/)[0]); } catch { out = ""; } }
  else if (cmd === "sleep") { await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "sh2glsl") {
    const args = rest.split(/\s+/);
    if (args[0] === "--vertex") {
      out = execFileSync(SH2GLSL, ["--vertex", args[1]]).toString();
    } else {
      out = execFileSync(SH2GLSL, [args[0]]).toString();
    }
  }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const { js } = await bashToJS(fs, src);
const out = { write: () => {} };
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: out, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, { HOME: "/home" }, out, out, shellExec, rt.sh2); } catch (e) { if (!e.message.includes("test-stop")) console.log("run err:", e.message.slice(0, 200)); }
const vert = String(await fs.read("/dev/webgl/shader/vertex") || "");
console.log("=== vertex shader (first 1500 chars) ===");
console.log(vert.slice(0, 1500));
console.log("=== has g_ucy_m:", vert.includes("g_ucy_m = int(uCamYaw * 1000.0)"));
console.log("=== has g_ucs:", vert.includes("g_ucs = int(uCamShift * 1000.0)"));
console.log("=== has g_relx * (0.45):", vert.includes("g_relx * (0.45)"));
console.log("=== has gl_Position vec4:", vert.includes("gl_Position = vec4(g_vp_x, g_vp_y, g_vp_z, g_vp_w)"));
