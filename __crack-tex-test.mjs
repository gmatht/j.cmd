// ─── __crack-tex-test.mjs — the crack overlay is a VARIED texture ────
//
// STATUS: NOT IN deploy-gates.sh — the observation hook is wrong, not the
// product. The game uploads textures with a shell redirect
// (`cat /tmp/… > /dev/webgl/texture/$idx`), which the device path handles
// without going through fs.write/fs.writeSync, so this probe sees no
// writes at all (TEXWRITES=) and its failures are a harness artefact.
// It needs to observe the device's texture store instead (webgldev's
// internal texture map, or a device-level read of the unit).
//
// The question it is built to answer is real and open: "damaged blocks
// are just dim and show no crack texture". If `uCrack` is never bound
// (or bound to an empty unit), the sampler returns (0,0,0,1) — a
// CONSTANT alpha — so `cr_a` stops varying and every damaged pixel
// blends toward the same value: a uniform dimming with no crack lines
// (and, before the /4 weight fix, a solid near-black block).
// A damaged block must show dark crack LINES, not a uniform dimming. A
// uniform dim means the shader reads a constant where the crack texture
// should be: either the RGBA payload lost its alpha channel on upload
// (so `cr_a` is constant and every pixel blends the same) or the crack
// sample never varies. This drives the game's real upload path
// (load_tex4, 4 channels) and inspects the bytes the device actually
// holds for the crack unit.
import { fs } from "./src/fs/index.js";
import { bashToJS, runTranspiled } from "./src/bash2js.js";
import { readFileSync } from "node:fs";

const game = readFileSync("www/bin/mimecroft.sh", "utf8").replace(/\nmain\s*$/, "\n");
const { js } = await bashToJS(fs, game);

// capture the payload the game uploads to texture unit 9 (the crack
// overlay) — the device path is write-only, so observe the write.
let crackPayload = "";
const seen = [];
const origWrite = fs.write.bind(fs);
fs.write = async (p, c) => {
  if (String(p).includes("/webgl/texture/")) seen.push(String(p) + ":" + String(c).length);
  if (/\/webgl\/texture\/9$/.test(String(p))) crackPayload = String(c);
  return origWrite(p, c);
};
const origWriteSync = fs.writeSync ? fs.writeSync.bind(fs) : null;
if (origWriteSync) fs.writeSync = (p, c) => {
  if (String(p).includes("/webgl/texture/")) seen.push("S" + String(p) + ":" + String(c).length);
  if (/\/webgl\/texture\/9$/.test(String(p))) crackPayload = String(c);
  return origWriteSync(p, c);
};
globalThis.__texWrites = () => seen.join(" ");

globalThis.__crackPayload = () => crackPayload;
const driver = `
const __say = (s) => process.stdout.write(s + "\\n");
// the REAL upload path for the crack overlay (the texture stage in
// main; start_level does not generate textures)
await sh2.exec("set_tex_size", []).catch(() => {});
texture_size = 16; tex_size = 16; tex_seed = 7; tex_ver = "t";
await sh2.exec("load_tex4", ["crack", 9]);
await new Promise((r) => setTimeout(r, 60));
const raw = globalThis.__crackPayload();
__say("TEXWRITES=" + globalThis.__texWrites());
__say("RAWLEN=" + raw.length);
__say("RAWHEAD=" + JSON.stringify(raw.slice(0, 120)));
const nums = raw.trim().split(/[\\s,]+/).filter(Boolean).map(Number);
__say("NNUM=" + nums.length);
if (nums.length % 4 === 0 && nums.length > 0) {
  const A = [], R = [];
  for (let i = 0; i + 3 < nums.length; i += 4) { R.push(nums[i]); A.push(nums[i + 3]); }
  __say("ALPHA_MIN=" + Math.min(...A) + " ALPHA_MAX=" + Math.max(...A) + " ALPHA_N=" + new Set(A).size);
  __say("RGB_MIN=" + Math.min(...R) + " RGB_MAX=" + Math.max(...R));
  __say("TRANSPARENT=" + A.filter((a) => a === 0).length + " OPAQUE=" + A.filter((a) => a === 255).length);
} else {
  __say("NOT_RGBA=1 mod=" + (nums.length % 4));
}
`;
let out = "";
await runTranspiled(fs, js + driver, {
  stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
  runCmd: async () => ({ out: "", err: "", code: 127 }), args: [], argv0: "crack-tex-test",
});
if (process.env.CT_DEBUG) console.log(out);
const num = (k) => { const m = new RegExp("^" + k + "=(-?\\d+)", "m").exec(out); return m ? Number(m[1]) : null; };
const str = (k) => { const m = new RegExp("^" + k + "=(.*)$", "m").exec(out); return m ? m[1].trim() : null; };
let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };
check("the crack texture reaches the device (unit 9)", (num("NNUM") || 0) > 0, str("RAWHEAD") || "empty");
check("the crack payload is RGBA (4 values per texel)", num("NNUM") % 4 === 0 && !num("NOT_RGBA"),
  "values=" + num("NNUM") + " mod=" + num("NNUM") % 4);
check("the crack texture has a transparent background", (num("TRANSPARENT") || 0) > 0,
  "transparent texels=" + num("TRANSPARENT"));
check("the crack texture has opaque crack lines", (num("OPAQUE") || 0) > 0,
  "opaque texels=" + num("OPAQUE"));
check("alpha VARIES (a constant alpha = uniform dimming, no cracks)",
  (num("ALPHA_N") || 0) >= 2, "distinct alpha values=" + num("ALPHA_N") +
  " (min=" + num("ALPHA_MIN") + " max=" + num("ALPHA_MAX") + ")");
check("crack lines are dark", (num("RGB_MAX") || 255) < 128, "rgb max=" + num("RGB_MAX"));
console.log(fails === 0 ? "ALL CRACK-TEX CHECKS PASSED" : `${fails} CRACK-TEX CHECKS FAILED`);
process.exit(fails ? 1 : 0);
