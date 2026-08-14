// ─── __label-visual.mjs — dump the generated treasure label textures ─
// Runs the game startup far enough to generate the labels, then writes
// each /dev/webgl/texture/<idx> label as a PPM (scaled 8×) for visual
// inspection: 0 = GNU Hurd … 9 = Unix.
import { readFileSync, writeFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
let src = readFileSync("examples/mimecroft.sh", "utf8");
// replace main() so the game stops right after the labels are made
src = src.replace(
  "    echo \"  generating treasure labels…\"\n    load_labels\n    echo \"  ready.\"",
  "    echo \"  generating treasure labels…\"\n    load_labels\n    echo \"  ready.\"\n    quit=1\n    echo \"GAME DONE\"\n    return"
);
const { js } = await bashToJS(fs, src);
const stdout = [];
const shellExec = async (cmdline) => {
  const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") { try { out = await fs.read(rest.split(/\s+/)[0]); } catch (e) { out = ""; } }
  else if (cmd === "sleep") { await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: out, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
try { await fn([], fs, { HOME: "/home" }, out, out, shellExec, rt.sh2); }
catch (e) { console.log("RUN ERROR:", e.message); process.exit(1); }
// reach into the device for the raw pixels
let webgl = null;
for (const k of Object.keys(fs.mounts)) {
  const b = fs.mounts[k].backend;
  if (b && b._webgl && b._webgl._texPixels && b._webgl._texPixels.size > 0) webgl = b._webgl;
}
if (!webgl || !webgl._texPixels) { console.log("could not reach WebGLDevice._texPixels"); process.exit(1); }
const names = ["GNU Hurd", "Linux", "FreeBSD", "NetBSD", "OpenBSD", "Plan 9", "Minix", "Solaris", "macOS Darwin", "Unix"];
for (let i = 0; i < 10; i++) {
  const idx = 21 + i;
  const px = webgl._texPixels.get(idx);
  if (!px) { console.log(`texture ${idx} missing`); continue; }
  const { size, rgba } = px;
  const S = size * 8; // scale 8×
  let ppm = `P6\n${S} ${S}\n255\n`;
  const buf = Buffer.alloc(S * S * 3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const s = ((y >> 3) * size + (x >> 3)) * 4;
      const o = (y * S + x) * 3;
      buf[o] = rgba[s]; buf[o + 1] = rgba[s + 1]; buf[o + 2] = rgba[s + 2];
    }
  }
  writeFileSync(`/tmp/label-${i}-${names[i].replace(/ /g, "_")}.ppm`, Buffer.concat([Buffer.from(ppm), buf]));
  console.log(`wrote /tmp/label-${i} (${names[i]}): ${size}x${size} RGBA, alpha-255 pixels: ${[...rgba].filter((v, k) => k % 4 === 3 && v === 255).length}`);
}
console.log("GAME DONE");
