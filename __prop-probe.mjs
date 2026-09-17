// render a cube at several positions with the FIXED shader + distinct face
// colors, and measure the on-screen proportions (front-face w/h, depth extent)
import { readFileSync } from "node:fs";
import gl0 from "gl";
import { WebGLDevice } from "./src/fs/webgldev.js";
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const vs0 = /vs_fb="([^"]+)"/.exec(src)[1];
const vs = vs0.replace("rel.x * 0.45 + uCamShift * w", "rel.x * 0.3375 + uCamShift * w");  // aspect-corrected
const frag = /fs_fb="([^"]+)"/.exec(src)[1] + " gl_FragColor = vec4(c, 1.0); }";
// distinct faces: top W, bottom g, +z Y, -z B, +x G, -x R
const SHADES =
  "1 1 1 1 1 1 1 1 1 1 1 1 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 " +
  "1 1 0 1 1 0 1 1 0 1 1 0 0 0 1 0 0 1 0 0 1 0 0 1 0 1 0 0 1 0 0 1 0 0 1 0 1 0 0 1 0 0 1 0 0 1 0 0";
WebGLDevice.prototype._ensureGL = function () {
  if (this._gl) return this._gl;
  this._canvas = { width: 800, height: 600, style: {}, toDataURL: () => "data:," };
  const gl = gl0(800, 600);
  this._gl = gl; this._null = false; this._contextName = "headless-gl";
  try { gl.viewport(0, 0, 800, 600); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); } catch {}
  return gl;
};
const dev = new WebGLDevice();
const w = async (p, d) => { await dev.write(p, d); };
await w("/shader/vertex", vs);
await w("/shader/fragment", frag);
try { await w("/program", "link"); } catch (e) { console.log("link fail", e.message); }
const pos = /f32 ((-?0\.5[ 0-9.]*)+)" > \/dev\/webgl\/buffer\/aPosition/.exec(src)[1];
const uv = /f32 ([0-9 ]+)" > \/dev\/webgl\/buffer\/aUv/.exec(src)[1];
const idx = /u16 ([0-9 ]+)" > \/dev\/webgl\/buffer\/cube/.exec(src)[1];
await w("/buffer/aPosition", "f32 " + pos);
await w("/buffer/aShade", "f32 " + SHADES);
await w("/buffer/aUv", "f32 " + uv);
await w("/buffer/cube", "u16 " + idx);
const size = 16;
const bytes = new Uint8Array(size * size * 3).fill(255);
await w("/texture/0", size + " " + Array.from(bytes).join(" "));
await w("/uniform/1i/uTex", "0");
await w("/uniform/1f/uOverlay", "0");
await w("/uniform/3f/uCamPos", "8 1.1 8");
await w("/uniform/1f/uCamYaw", "0");
await w("/uniform/3f/uScale", "1 1 1");
await w("/uniform/3f/uBlockColor", "1 1 1");
await w("/clearcolor", "0 0 0 1");

function measure(objx, objz) {
  return (async () => {
    await w("/uniform/3f/uObjPos", objx + " 1 " + objz);
    await w("/call", "clear");
    await w("/call", "draw elements triangles 36 0 cube");
    const gl = dev._gl;
    const px = Buffer.alloc(800 * 600 * 4);
    gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const is = (x, sy, f) => { const i = ((600 - 1 - sy) * 800 + x) * 4; const c = px; return f(c[i], c[i+1], c[i+2]); };
    const face = (x, y) => {
      const i = ((600 - 1 - y) * 800 + x) * 4;
      const r = px[i], g = px[i+1], b = px[i+2];
      if (r > 150 && g > 150 && b > 150) return "W";   // top (white)
      if (g > 150 && r < 60 && b < 60) return "G";     // +x
      if (b > 150 && r < 60 && g < 60) return "B";     // -z
      if (r > 150 && g < 60 && b < 60) return "R";     // -x
      if (r > 150 && g > 150 && b < 60) return "Y";    // +z
      return ".";
    };
    // bounding boxes per face
    const boxes = {};
    for (let y = 0; y < 600; y += 2) for (let x = 0; x < 800; x += 2) {
      const f = face(x, y);
      if (f !== ".") {
        const bb = boxes[f] || (boxes[f] = { minx: 9999, maxx: -1, miny: 9999, maxy: -1 });
        if (x < bb.minx) bb.minx = x; if (x > bb.maxx) bb.maxx = x;
        if (y < bb.miny) bb.miny = y; if (y > bb.maxy) bb.maxy = y;
      }
    }
    return boxes;
  })();
}

// dump the same-row block's shape as ASCII
{
  await w("/uniform/3f/uObjPos", "7 1 8");
  await w("/call", "clear");
  await w("/call", "draw elements triangles 36 0 cube");
  const gl = dev._gl;
  const px2 = Buffer.alloc(800 * 600 * 4);
  gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px2);
  const f2 = (x, y) => {
    const i = ((600 - 1 - y) * 800 + x) * 4;
    const r = px2[i], g = px2[i+1], b = px2[i+2];
    if (r > 150 && g > 150 && b > 150) return "W";
    if (g > 150 && r < 60) return "G";
    if (b > 150 && r < 60) return "B";
    if (r > 150 && g < 60) return "R";
    if (r > 150 && g > 150 && b < 60) return "Y";
    return ".";
  };
  console.log("--- same-row left block shape (x 0..320, y 300..600) ---");
  for (let sy = 600; sy >= 300; sy -= 12) {
    let row = "";
    for (let x = 0; x <= 320; x += 12) row += f2(x, sy);
    console.log(String(sy).padStart(4) + " " + row);
  }
}
for (const [label, x, z] of [["ahead (8,7)", 8, 7], ["ahead (8,5)", 8, 5], ["ahead-left (7,5)", 7, 5], ["ahead-left (6,4)", 6, 4], ["same-row left (7,8)", 7, 8]]) {
  const boxes = await measure(x, z);
  const fmt = (f) => { const b = boxes[f]; return b ? `w=${b.maxx-b.minx} h=${b.maxy-b.miny}` : "–"; };
  console.log(`${label}: front+z [${fmt("Y")}] front-z [${fmt("B")}] side+x [${fmt("G")}] top [${fmt("W")}]`);
}
