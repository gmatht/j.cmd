// ─── __3d-colour-test.mjs — the 3D view renders in more than one colour ─
// Drives the REAL game pipeline headlessly: the bash-authored shaders
// compiled by sh2glsl (vertex + the exact fragment lines
// emit_fragment_shader writes with CRT/CORRUPT off), three solid-colour
// textures uploaded, three cubes drawn through the game's batched
// /dev/webgl/blocks payload, then readPixels.
//
// Catches the outage family that log-grepping cannot:
//   • black 3D (failed link/draws — every blocks write rejected);
//   • mono-colour 3D (lighting/tint/texture broken — pixels render but
//     a single shade; the HUD still works, so menu-level checks pass);
//   • fragment regression (the `$b` frag corruption changed putb lines
//     → different bytes → link or tint failure here).
//
//   node __3d-colour-test.mjs   → "ALL 3D COLOUR CHECKS PASSED"
import { readFileSync } from "node:fs";
import gl0 from "gl";
import { execFileSync } from "node:child_process";
import { WebGLDevice } from "./src/fs/webgldev.js";
import { getOtranspilerl } from "./src/otranspilerl.js";

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

WebGLDevice.prototype._ensureGL = function () {
  if (this._gl) return this._gl;
  this._canvas = { width: 800, height: 600, style: {}, toDataURL: () => "data:," };
  const gl = gl0(800, 600);
  this._gl = gl;
  this._null = false;
  this._contextName = "headless-gl";
  try { gl.viewport(0, 0, 800, 600); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); } catch {}
  return gl;
};
const dev = new WebGLDevice();
const w = async (path, data) => { await dev.write(path, data); };

const lib = await getOtranspilerl();
// the shaders the game ACTUALLY uses (same sources, same compiler)
await w("/shader/vertex", lib.glslv(readFileSync("www/examples/mimecroft-vertex.sh", "utf8")));
const cleanFrag = [
  "r=$((vcolor_r))", "g=$((vcolor_g))", "b=$((vcolor_b))",
  "r=$((r * tex_r / 128))", "g=$((g * tex_g / 128))", "b=$((b * tex_b / 128))",
  "if [ \"$r\" -lt 0 ]; then r=0; fi", "if [ \"$g\" -lt 0 ]; then g=0; fi", "if [ \"$b\" -lt 0 ]; then b=0; fi",
  "putb $r", "putb $g", "putb $b", "putb 255",
].join("\n") + "\n";
const fragSrc = lib.glsl(cleanFrag);
await w("/shader/fragment", fragSrc);
await w("/program", "link");
check("shaders link (vertex + game fragment)", dev._programLinked, "linked=" + !!dev._programLinked);

// cube geometry: the EXACT buffers setup_webgl writes (read from the
// game source so the test tracks it — a hand-truncated 8-vert copy
// drew nothing under headless-gl, 0x502)
const gameSrc = readFileSync("www/bin/mimecroft.sh", "utf8");
const bufLine = (name) => {
  const m = gameSrc.match(new RegExp("echo \"(f32 [0-9.\\- ]+|u16 [0-9 ]+)\" > /dev/webgl/buffer/" + name));
  if (!m) throw new Error("game buffer missing: " + name);
  return m[1];
};
await w("/buffer/aPosition", bufLine("aPosition"));
await w("/buffer/aShade", bufLine("aShade"));
await w("/buffer/aUv", bufLine("aUv"));
await w("/buffer/cube", bufLine("cube"));

// three SOLID textures (red / green / blue 16x16) — a missing-texture
// fault renders flat block colour instead; both faults are coloured,
// so the test counts clusters, not exact texels
for (const [slot, r, g, b] of [[1, 255, 0, 0], [2, 0, 255, 0], [3, 0, 0, 255]]) {
  const bytes = new Uint8Array(16 * 16 * 3);
  for (let i = 0; i < 16 * 16; i++) { bytes[i * 3] = r; bytes[i * 3 + 1] = g; bytes[i * 3 + 2] = b; }
  await w("/texture/" + slot, "16 " + Array.from(bytes).join(" "));
}

// camera looking down -z at three cubes side by side (x=-2,0,2)
await w("/uniform/3f/uCamPos", "0 0.9 6");
await w("/uniform/1f/uCamYaw", "0");
await w("/uniform/1f/uCamShift", "0");
await w("/uniform/1f/uOverlay", "0");
await w("/uniform/1i/uDamage", "0");
await w("/clearcolor", "0 0 0 1");
await w("/call", "clear");
// x y z sx sy sz r g b tx dam — white tint so the texture colour shows
await w("/blocks", "-2 0 0 1 1 1 255 255 255 1 0\n0 0 0 1 1 1 255 255 255 2 0\n2 0 0 1 1 1 255 255 255 3 0\n");
await w("/call", "swap");

const gl = dev._gl;
const px = Buffer.alloc(800 * 600 * 4);
gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px);
const sample = (x, y) => { const i = ((600 - 1 - y) * 800 + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
const errs = [];
while (true) { const e = gl.getError(); if (e === 0) break; errs.push(e); }

let nz = 0;
for (let i = 0; i < px.length; i += 4) if (px[i] > 8 || px[i + 1] > 8 || px[i + 2] > 8) nz++;
check("cubes rendered (non-black pixels)", nz > 500, nz + " lit pixels");

// colour clusters across the frame (quantized to /64 — lighting shades
// one cube across 2 buckets max, so 3 cubes need >= 3 clusters; a
// mono-colour fault — flat black, flat grey, single tint — gives 1)
const buckets = new Set();
for (let y = 0; y < 600; y += 6) {
  for (let x = 0; x < 800; x += 6) {
    const p = sample(x, y);
    if (p[0] < 8 && p[1] < 8 && p[2] < 8) continue;
    buckets.add(Math.floor(p[0] / 64) + "," + Math.floor(p[1] / 64) + "," + Math.floor(p[2] / 64));
  }
}
check("3D is not mono-colour (distinct colour clusters)", buckets.size >= 3, buckets.size + " clusters: " + [...buckets].slice(0, 6).join(" "));

// saturation floor on REAL game content: a dirt cube with the generated
// dirt texture and the game's dirt tint must stay BROWN (saturated), not
// wash to grey — the "3D is still grey" outage (failed tint, grey crack
// overlay stuck on, desaturating fragment) keeps distinct clusters but
// kills saturation, so the cluster check above stays green while the
// game looks wrong. This check fails it.
{
  const { execFileSync } = await import("node:child_process");
  const dirtTSV = execFileSync("bash", ["www/examples/textures/texture-dirt.sh", "--tsv", "--size", "16", "--seed", "20240812"], { encoding: "utf8" });
  const nums = dirtTSV.split("\n").filter((l) => l && !l.startsWith("#")).join(" ").split(/\s+/).filter(Boolean);
  await w("/texture/9", "16 " + nums.join(" "));
  await w("/call", "clear");
  // dirt tint 0.55,0.35,0.20 (game block_color case 1), damage 0
  await w("/blocks", "0 0 0 1 1 1 0.55 0.35 0.20 9 0\n");
  await w("/call", "swap");
  gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > 8 || px[i + 1] > 8 || px[i + 2] > 8) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
  }
  if (!n) {
    check("dirt stays brown (saturated, not grey)", false, "no dirt pixels rendered");
  } else {
    r /= n; g /= n; b /= n;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    // dirt brown (65,32,6)-ish through the tint: R clearly above B.
    // Grey (r≈g≈b) or black both fail here even with 3+ clusters elsewhere.
    check("dirt stays brown (saturated, not grey)", sat > 8 && r > b + 5,
      `avg RGB=(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)}) sat=${sat.toFixed(0)} n=${n}`);
  }
}
// GENERATED texture displays with detail (not flat): grass TSV via
// host bash (deterministic seed), uploaded, rendered with a WHITE tint
// (1 1 1 in the game's 0-1 range — NOT 255, which blows out to white)
// so the texels show unmodified. Asserts pixel VARIANCE across the face
// (a broken sampler/upload shows flat grey/white/black; a working one
// shows the grass's green variation) and greenish average hue (right
// texture, not cross-slot garbage). End-to-end generated → displayed.
{
  const grassTSV = execFileSync("bash", ["www/examples/textures/texture-grass.sh", "--tsv", "--size", "16", "--seed", "20240812"], { encoding: "utf8" });
  const gnums = grassTSV.split("\n").filter((l) => l && !l.startsWith("#")).join(" ").split(/\s+/).filter(Boolean);
  await w("/texture/7", "16 " + gnums.join(" "));
  await w("/uniform/3f/uCamPos", "0 0.9 6");
  await w("/uniform/1f/uCamYaw", "0");
  await w("/uniform/1f/uCamShift", "0");
  await w("/uniform/1f/uOverlay", "0");
  await w("/uniform/1i/uDamage", "0");
  await w("/clearcolor", "0 0 0 1");
  await w("/call", "clear");
  await w("/blocks", "0 0 0 1 1 1 1 1 1 7 0\n");
  await w("/call", "swap");
  gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const buckets = new Set();
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < 600; y += 4) {
    for (let x = 0; x < 800; x += 4) {
      const p = sample(x, y);
      if (p[0] < 8 && p[1] < 8 && p[2] < 8) continue;
      buckets.add(Math.floor(p[0] / 32) + "," + Math.floor(p[1] / 32) + "," + Math.floor(p[2] / 32));
      r += p[0]; g += p[1]; b += p[2]; n++;
    }
  }
  check("generated grass texture shows detail (not flat)", buckets.size >= 4, buckets.size + " buckets");
  if (n) {
    r /= n; g /= n; b /= n;
    check("generated grass reads green (right texture)", g > r && g > b, `avg RGB=(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)}) n=${n}`);
  } else {
    check("generated grass reads green (right texture)", false, "no pixels");
  }
}

check("no GL errors", errs.length === 0, errs.map((e) => e.toString(16)).join(","));
console.log(fails === 0 ? "ALL 3D COLOUR CHECKS PASSED" : `${fails} 3D COLOUR CHECKS FAILED`);
process.exit(fails ? 1 : 0);
