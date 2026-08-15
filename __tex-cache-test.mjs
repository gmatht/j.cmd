// ─── Reproduction: stale/broken /home texture cache ───────────────
// Plant a BROKEN payload (raw TSV from an old loader version — starts
// with "#texture" not "SIZE") in /home under the CURRENT cache key,
// run the game with DEFAULT settings, and check:
//   • does the device log a texture rejection (bad data)?
//   • does the game end up with flat-colour (no texture) blocks?
// Then confirm that bumping the seed/size key (a settings change)
// forces regeneration and the texture uploads.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1             # enabled for the mime tests");
src = src.replace("TREASURE_TOTAL=10", "TREASURE_TOTAL=3");
const { js } = await bashToJS(fs, src);

// plant broken caches for the DEFAULT key (name-32-20240812-9):
// an old raw-TSV payload and an empty file — the two realistic
// failure shapes a persistent /home could hold
const KEY = (n) => `/home/mimecroft-tex-${n}-32-20240812-9`;
const BROKEN_TSV = "#texture\tstone\t32x32\t255 0 0 0 255 0 0 0 255\n";
await fs.write(KEY("stone"), BROKEN_TSV);
await fs.write(KEY("dirt"), ""); // empty (truncated) payload

let keyFrame = 0;
const KEYS = ["q,"];
const stdout = [];
const shellExec = async (cmdline) => {
  const cl = cmdline.trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "bash") {
    // the browser runs the generator scripts through its own bash —
    // the test stub can't; execute the real script on the host instead
    const { execFileSync } = await import("node:child_process");
    const script = cl.split(/\s+/)[1].replace(/^\/+/, "");
    try { out = execFileSync("bash", [script, "--tsv", "--size", "32", "--seed", "20240812"], { encoding: "utf8" }); }
    catch (e) { out = ""; }
  }
  else if (cmd === "cat") {
    // handle "cat SRC > DEVICE" (a real device redirect — the stub
    // otherwise returns the content as stdout and drops the write)
    const m = rest.match(/^(\S+)\s*>\s*(\S+)/);
    if (m) {
      const src = fs._resolve(m[1]);
      const dst = fs._resolve(m[2]);
      if (src === "/dev/webgl/key") { out = (keyFrame < KEYS.length ? KEYS[keyFrame] : "q,") + "\n"; keyFrame++; }
      else {
        try { const c = await fs.read(src); await fs.write(dst, c); out = ""; }
        catch (e) { out = ""; }
      }
    } else {
      const p = fs._resolve(rest.split(/\s+/)[0]);
      if (p === "/dev/webgl/key") { out = (keyFrame < KEYS.length ? KEYS[keyFrame] : "q,") + "\n"; keyFrame++; }
      else { try { out = await fs.read(p); } catch (e) { out = ""; } }
    }
  }
  else if (cmd === "sleep") {}
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const errOut = { write: (s) => stdout.push("[err] " + s) };
const ow = process.stdout.write.bind(process.stdout);
process.stdout.write = (s, ...rest) => { stdout.push(String(s)); return ow(s, ...rest); };
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: out, stderr: errOut, args: [], argv0: "bash" });
const origSh2ReadFile = rt.sh2.fs.readFile.bind(rt.sh2.fs);
rt.sh2.fs.readFile = async (p, enc) => {
  if (String(p) === "/dev/webgl/key") { const k = keyFrame < KEYS.length ? KEYS[keyFrame] : "q,"; keyFrame++; return k; }
  return origSh2ReadFile(p, enc);
};
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + js + " })();");
await fn([], fs, { HOME: "/home" }, out, errOut, shellExec, rt.sh2);
const log = await fs.read("/dev/webgl/log");
console.log("── device texture log ──");
console.log(log.split("\n").filter((l) => l.includes("texture/")).join("\n"));
console.log("── textures actually uploaded ──");
const uploaded = log.match(/\[texture\/(\d+)\] \d+x\d+ uploaded/g) || [];
const rejected = log.match(/\[texture\/(\d+)\] (bad data|short data)[^\n]*/g) || [];
console.log("uploaded:", uploaded.length, "| rejected:", rejected.length);
console.log("stone(1) uploaded?", uploaded.some((u) => u.includes("texture/1] ")));
console.log("dirt(8) uploaded?", uploaded.some((u) => u.includes("texture/8] ")));
// inspect the /tmp cache files the game wrote
const dir = await fs.list("/tmp");
const names = dir.map((e) => (typeof e === "string" ? e : e.name));
const caches = names.filter((n) => n && n.startsWith("mimecroft-tex-"));
const jpeg = caches.find((n) => n.includes("jpeg"));
let jpegOk = false;
if (jpeg) { const c = await fs.read("/tmp/" + jpeg); const toks = c.split(/\s+/).filter(Boolean); const size = Number(toks[0]); jpegOk = !Number.isNaN(size) && toks.length === 1 + size * size * 3; }
const ok =
  rejected.length === 0 &&                        // nothing rejected
  uploaded.some((u) => u.includes("texture/1] ")) &&  // stone regenerated
  uploaded.some((u) => u.includes("texture/8] ")) &&  // dirt regenerated
  jpegOk;                                         // /tmp cache holds a valid payload
console.log("tmp cache files:", caches.length, "| jpeg payload valid:", jpegOk);
console.log("texture cache robustness:", ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
