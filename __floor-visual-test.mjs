// ─── __floor-visual-test.mjs — REAL-GL proof the floor plane tiles ─
// Renders a horizontal floor QUAD (no bottom face — no depth ambiguity)
// through the REAL WebGLDevice (headless-gl) with the GENERATED vertex
// + fragment shaders and a synthetic 16×16 texture (every texel
// distinct: R=x·16, G=y·16, B=100) uploaded with gl.REPEAT.
//
// Verifies:
//   1. the plane renders (pixels on screen, no GL errors);
//   2. horizontal tiling: floor pixels at different world x show
//      DIFFERENT texel columns (R = 16·column);
//   3. vertical tiling: pixels at different world z (depth) show
//      DIFFERENT texel rows (G = 16·row) — this is the REPEAT wrap:
//      a CLAMPed texture would smear the edge texel, a flat colour
//      would be uniform.
// (headless-gl uploads texture rows flipped vs the browser — the flip
// only inverts the vertical cycle direction; tiling is unchanged.)
import { readFileSync } from "node:fs";
import gl0 from "gl";
import { WebGLDevice } from "./src/fs/webgldev.js";
import { getOtranspilerl } from "./src/otranspilerl.js";

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
await w("/shader/vertex", lib.glslv(readFileSync("www/examples/mimecroft-vertex.sh", "utf8")));
// the fragment program the game ACTUALLY emits at runtime with
// CRT_ON=0/CORRUPT_ON=0 (emit_fragment_shader writes these lines) —
// no scanline/vignette/corruption effects
const cleanFrag = [
  "fx=$((frag_x))", "fy=$((frag_y))",
  "r=$((vcolor_r))", "g=$((vcolor_g))", "b=$((vcolor_b))",
  "r=$((r * tex_r / 128))", "g=$((g * tex_g / 128))", "b=$((b * tex_b / 128))",
  "if [ \"$r\" -lt 0 ]; then r=0; fi", "if [ \"$g\" -lt 0 ]; then g=0; fi", "if [ \"$b\" -lt 0 ]; then b=0; fi",
  "putb $r", "putb $g", "putb $b", "putb 255",
].join("\n") + "\n";
await w("/shader/fragment", lib.glsl(cleanFrag));
await w("/program", "link");
// a horizontal quad at local y=0.5, ±0.5 x/z — drawn with uScale 40 → the
// vertex shader's usc_x>1100 branch feeds it WORLD-xz UVs (0.5·40 = ±20)
await w("/buffer/aPosition", "f32 -0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 -0.5 0.5 -0.5");
await w("/buffer/aShade", "f32 1 1 1 1 1 1 1 1 1 1 1 1");
await w("/buffer/aUv", "f32 0 0 1 0 1 1 0 1");
await w("/buffer/quad", "u16 0 1 2 0 2 3");

// synthetic 16×16 texture: texel (x,y) = RGB(x*16, y*16, 100)
const size = 16;
const bytes = new Uint8Array(size * size * 3);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const i = (y * size + x) * 3;
  bytes[i] = x * 16; bytes[i + 1] = y * 16; bytes[i + 2] = 100;
}
await w("/texture/8", size + " " + Array.from(bytes).join(" "));

// player at (2,2) facing -z; the floor quad centred under the camera
await w("/uniform/3f/uCamPos", "2 1.1 2");
await w("/uniform/1f/uCamYaw", "0");
await w("/uniform/1f/uCamShift", "0");
await w("/uniform/1f/uOverlay", "0");
await w("/uniform/1i/uDamage", "0");
await w("/clearcolor", "0 0 0 1");
await w("/call", "clear");
// floor quad: uObjPos=(2,0,2) uScale=(40,1,40) → top at y=0.5, ±20 wide
await w("/uniform/3f/uObjPos", "2 0 2");
await w("/uniform/3f/uScale", "40 1 40");
await w("/uniform/3f/uBlockColor", "1 1 1");
await w("/uniform/1i/uTex", "8");
await w("/call", "draw elements triangles 6 0 quad");
await w("/call", "swap");

const gl = dev._gl;
const px = Buffer.alloc(800 * 600 * 4);
gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px);
const sample = (x, y) => { const i = ((600 - 1 - y) * 800 + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
const errs = [];
while (true) { const e = gl.getError(); if (e === 0) break; errs.push(e); }

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

let nz = 0;
for (let i = 0; i < px.length; i += 4) if (px[i] || px[i + 1] || px[i + 2]) nz++;
check("floor quad rendered", nz > 1000, nz + " pixels");

// the floor fills the lower screen — find rows with floor pixels
const rowPix = (y) => { let c = 0; for (let x = 0; x < 800; x += 4) { const p = sample(x, y); if (p[0] || p[1] || p[2]) c++; } return c; };
let firstRow = -1, lastRow = -1;
for (let y = 599; y >= 300; y--) { const c = rowPix(y); if (c > 100 && firstRow < 0) firstRow = y; if (c > 100) lastRow = y; }
console.log("  floor rows: first(nearest)=" + firstRow + " last(farthest)=" + lastRow);
if (firstRow < 0) { console.log("  no floor rows found"); process.exit(1); }

// 1) HORIZONTAL tiling: at the NEAREST row, sample x across the screen;
//    R = 16·(texel column) must VARY with world x
const hColors = [];
for (let x = 60; x < 740; x += 40) hColors.push(sample(x, firstRow));
console.log("  h-line y=" + firstRow + ":", hColors.map((c, i) => `x${60 + i * 40}:${c}`).join(" "));
const hR = new Set(hColors.map((c) => Math.round(c[0] / 16)));
check("horizontal tiling — texel columns vary across the floor", hR.size >= 4, hR.size + " distinct columns (R/16: " + [...hR].join(",") + ")");

// 2) VERTICAL tiling: at screen centre x=400, sample rows from near to
//    far; G = 16·(texel row) must CHANGE with depth (REPEAT) — a
//    CLAMPed texture would smear ONE edge row. (headless-gl drops the
//    near floor at the degenerate w=0 clip — the thin far band still
//    shows the row cycling; the browser's ANGLE renders the full
//    plane, as the game already does.)
const vColors = [];
for (let y = firstRow; y >= lastRow && y > 300; y -= 8) vColors.push(sample(400, y));
const gVals = new Set(vColors.map((c) => Math.round(c[1] / 16)));
console.log("  v-line x=400 rows " + lastRow + ".." + firstRow + " G/16:", [...gVals].join(","));
check("vertical tiling — texel rows change with depth (REPEAT)", gVals.size >= 2, gVals.size + " distinct rows");

// 3) the texels are MY synthetic texture's: every sample's B channel is
//    the tinted B=100 (127·100/128 = 99) — no other texture, no flat
//    colour, no clamp smear
const allSamples = [...hColors, ...vColors];
const bOk = allSamples.filter((c) => c[2] >= 94 && c[2] <= 104).length;
check("samples carry the synthetic texture (B=100 through the 127/128 tint)", bOk >= allSamples.length - 2, bOk + "/" + allSamples.length);
// and R/G land on real tinted texels (15.875·n: ±4 of a multiple of 16)
const isTexel = (c) => {
  const r = Math.round(c[0] / 16) * 16, g = Math.round(c[1] / 16) * 16;
  return Math.abs(c[0] - r) <= 4 && Math.abs(c[1] - g) <= 4;
};
const realTexels = allSamples.filter(isTexel).length;
check("samples land on real texels (R,G ≡ 0 mod 16 ± tint)", realTexels >= allSamples.length - 2, realTexels + "/" + allSamples.length);

check("no GL errors", errs.length === 0, errs.map((e) => e.toString(16)).join(","));
process.exit(fails ? 1 : 0);
