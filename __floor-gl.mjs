import { readFileSync } from "node:fs";
import gl0 from "gl";
import { WebGLDevice } from "./src/fs/webgldev.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
WebGLDevice.prototype._ensureGL = function () {
  if (this._gl) return this._gl;
  this._canvas = { width: 800, height: 600, style: {}, toDataURL: () => "data:," };
  const gl = gl0(800, 600);
  this._gl = gl; this._null = false; this._contextName = "headless-gl";
  try { gl.viewport(0, 0, 800, 600); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); } catch {}
  return gl;
};
const dev = new WebGLDevice();
const w = async (path, data) => { await dev.write(path, data); };
const lib = await getOtranspilerl();
const vs = lib.glslv(readFileSync("www/examples/mimecroft-vertex.sh", "utf8"));
const fs = lib.glsl(readFileSync("www/examples/mimecroft-frag.sh", "utf8"));
await w("/shader/vertex", vs);
await w("/shader/fragment", fs);
await w("/program", "link");
// the cube buffers
const aPos = "-0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 -0.5 0.5 -0.5 -0.5 -0.5 0.5 0.5 -0.5 0.5 0.5 -0.5 -0.5 -0.5 -0.5 -0.5 -0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 -0.5 -0.5 0.5 -0.5 -0.5 0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 -0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 -0.5 -0.5 0.5 -0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 -0.5 -0.5";
await w("/buffer/aPosition", "f32 " + aPos);
await w("/buffer/aShade", "f32 1 1 1 1 1 1 1 1 1 1 1 1 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6");
await w("/buffer/aUv", "f32 0 0 1 0 1 1 0 1 0 0 1 0 1 1 0 1 0 0 1 0 1 1 0 1 1 1 0 1 0 0 1 0 0 1 0 0 1 0 1 1 1 1 1 0 0 0 0 1");
await w("/buffer/cube", "u16 0 1 2 0 2 3 4 5 6 4 6 7 8 9 10 8 10 11 12 13 14 12 14 15 16 17 18 16 18 19 20 21 22 20 22 23");
// a dirt-like 16x16 texture
const size = 16;
const bytes = new Uint8Array(size * size * 3);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const i = (y * size + x) * 3;
  const v = 100 + ((x * 7 + y * 13) % 60);
  bytes[i] = v; bytes[i+1] = v - 20; bytes[i+2] = v - 30;
}
await w("/texture/8", size + " " + Array.from(bytes).join(" "));
await w("/texture/1", size + " " + Array.from(bytes).join(" "));
// floor quad: 20 wide, camera at (2, 0.5, 2) yaw 0, quad at (12, 0.45, 12) size 20
await w("/uniform/3f/uCamPos", "2 0 2");
await w("/uniform/1f/uCamYaw", "0");
await w("/uniform/1f/uCamShift", "0");
await w("/uniform/3f/uObjPos", "2.5 0.5 1.5");
await w("/uniform/3f/uScale", "1 1 1");
await w("/uniform/3f/uBlockColor", "1 1 1");
await w("/uniform/1i/uTex", "1");
await w("/uniform/1i/uCrack", "8");
await w("/uniform/1i/uDamage", "0");
await w("/uniform/1f/uOverlay", "0");
await w("/call", "clear");
console.log("after clear:", dev._gl.getError());
console.log("before draw:", dev._gl.getError());
await w("/call", "draw elements triangles 36 0 cube");
console.log("after draw:", dev._gl.getError());
await w("/call", "swap");
const gl = dev._gl;
const px = Buffer.alloc(800 * 600 * 4);
gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px);
const sample = (x, y) => { const i = ((600 - 1 - y) * 800 + x) * 4; return [px[i], px[i+1], px[i+2]]; };
// sample a horizontal line across the floor (should show texture variation)
const line = [];
for (let x = 300; x <= 500; x += 40) line.push("x"+x+":"+sample(x, 400).join(","));
console.log("floor pixels:", line.join(" "));
console.log("err:", dev._gl.getError());
console.log("LOG:", dev._log.split("\n").filter(l => l.includes("shader") || l.includes("texture") || l.includes("FAILED") || l.includes("draw") || l.includes("link")).join(" | "));
