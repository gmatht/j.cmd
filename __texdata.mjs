// capture the game's real texture payloads + one frame's block lines
import { readFileSync, writeFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
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
    if (m) { const vert = !!m[1];
      try { const s2 = String(await fs.read(fs._resolve(m[2])));
        const { getOtranspilerl } = await import("./src/otranspilerl.js");
        const lib = await getOtranspilerl();
        out = vert ? lib.glslv(s2) : lib.glsl(s2);
      } catch { out = ""; } }
  }
  else if (cmd === "bash") {
    const parts = rest.split(/\s+/).filter(Boolean);
    const script = parts.shift();
    try {
      const p = fs._resolve(script);
      const txt = String(await fs.read(p));
      const t = "/tmp/.host-x-" + Math.random().toString(36).slice(2) + ".sh";
      const { writeFileSync, mkdirSync, unlinkSync } = await import("fs");
      mkdirSync("/tmp", { recursive: true });
      writeFileSync(t, txt);
      const t0 = Date.now();
      out = execFileSync("bash", [t, ...parts], { encoding: "utf8", timeout: 60000 });
      unlinkSync(t);
      if (script.includes("texture-")) console.log("BASH-TEX", JSON.stringify({ script, ms: Date.now() - t0, outLen: out.length, outHead: out.slice(0, 40) }));
    } catch (e) { out = ""; console.log("BASH-TEX-ERR", JSON.stringify({ script, e: e.message.slice(0, 80) })); }
  }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
import { execFileSync } from "node:child_process";
const out = { write: () => {} };
let webglDev = null;
for (const m of Object.values(fs.mounts || {})) {
  const b = m && m.backend;
  if (b && b._webgl) { webglDev = b._webgl; break; }
}
const rt = createSh2Runtime({ fs, env: { HOME: "/home", SH2_BG_TRACE: "1" }, shellExec, stdout: out, stderr: { write: () => {} }, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
const blocksPerFrame = [];
const origW = fs.write.bind(fs);
fs.write = async (path, content) => {
  const p = fs._resolve(path);
  if (p === "/dev/webgl/blocks" && blocksPerFrame.length < 3) blocksPerFrame.push(String(content));
  if (p.startsWith("/dev/webgl/texture/") && p.endsWith("/1")) {
    console.log("TEX1WRITE", JSON.stringify({ len: String(content).length, head: String(content).slice(0, 80) }));
  }
  if (p.startsWith("/tmp/mimecroft-bg-")) {
    console.log("BGDUMP", JSON.stringify({ name: p, len: String(content).length, head: String(content).slice(0, 60) }));
  }
  if (p.startsWith("/tmp/mimecroft-tex-")) {
    console.log("CACHEDUMP", JSON.stringify({ name: p, len: String(content).length, head: String(content).slice(0, 60) }));
  }
  return origW(path, content);
};
// wrap the worker submit to see the job results
const { bgSubmit: realBgSubmit, bgPeek: realBgPeek } = await import("./src/bgworker.js");
const origRead = webglDev.read.bind(webglDev);
let reads = 0;
webglDev.read = async (path) => {
  if (String(path).includes("key")) { reads++; webglDev._keys = reads > 300 ? ["q,"] : []; }
  return origRead(path);
};
let runError = null;
const done = fn([], fs, { HOME: "/home" }, out, { write: () => {} }, shellExec, rt.sh2).catch((e) => { runError = e; });
await Promise.race([done, new Promise((r) => setTimeout(r, 90000))]);
// dump the device textures (the parsed payloads)
const texInfo = {};
for (const [idx, t] of webglDev._textures) {
  const px = webglDev._texPixels.get(idx);
  texInfo[idx] = px ? { size: px.size } : "gl";
}
const first = blocksPerFrame[0] || "";
const lines = first.trim().split("\n").filter(Boolean).slice(0, 40);
console.log("TEXINFO", JSON.stringify(texInfo));
console.log("BLOCKLINES", JSON.stringify(lines.slice(0, 8).map((l) => l.slice(0, 60))));
console.log("BLOCKCOUNT", lines.length);
const texIdx = new Set();
for (const l of lines) { const n = l.split(/\s+/).map(Number); if (n.length >= 10) texIdx.add(n[9]); }
console.log("TEXINDICES", JSON.stringify([...texIdx]));
console.log("DEVLOC", JSON.stringify(webglDev._log.split("\n").filter((l) => l.includes("[texture/") || l.includes("[blocks") || l.includes("[shader") || l.includes("[program")).slice(0, 30)));
process.exit(0);
