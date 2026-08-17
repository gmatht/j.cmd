// ─── __flash-test.mjs — the muzzle-flash overlays must rasterize as
// FULL quads (a regression for the missing-triangle bug: the flash
// rects were drawn as a 4-vertex TRIANGLE_STRIP (BL,BR,TR,TL), whose
// second strip triangle overlaps the first on ANGLE-class drivers —
// each rect rendered as an incomplete ~75% shape with a visible missing
// corner).
import gl0 from "gl";
import { WebGLDevice } from "./src/fs/webgldev.js";

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

WebGLDevice.prototype._ensureGL = function () {
  if (this._gl) return this._gl;
  this._canvas = { width: 800, height: 600, style: {}, toDataURL: () => "data:," };
  const gl = gl0(800, 600);
  this._gl = gl; this._null = false; this._contextName = "headless-gl";
  try { gl.viewport(0, 0, 800, 600); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); } catch {}
  return gl;
};

function renderFlash(payload) {
  const dev = new WebGLDevice();
  const w = async (p, d) => { await dev.write(p, d); };
  return (async () => {
    await w("/clearcolor", "0 0 0 1");
    await w("/call", "clear");
    await w("/hud/flash", payload);
    await w("/call", "swap");
    const gl = dev._gl;
    const px = Buffer.alloc(800 * 600 * 4);
    gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0, minX = 9999, maxX = -1, minY = 9999, maxY = -1;
    for (let y = 0; y < 600; y++) for (let x = 0; x < 800; x++) {
      const i = ((600 - 1 - y) * 800 + x) * 4;
      if (px[i] > 150 && px[i + 1] > 100 && px[i + 2] < 120) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    return { n, bbox: [minX, maxX, minY, maxY] };
  })();
}

// a 0.22×0.22 NDC rect centred (0.55,-0.08) = 88×66 px = 5808 total
const glow = await renderFlash("R 0.55 -0.08 0.22 0.22 20 1.0 0.82 0.2\n");
const plain = await renderFlash("0.55 -0.08 0.22 0.22 1.0 0.82 0.2\n");

const FULL = 5808;        // the full 88×66 rect
const BROKEN = 4356;      // the old strip's ~75% coverage
check("flash rect n=0.22 fills the full quad (glow)", glow.n > FULL * 0.95, `px=${glow.n} vs full ${FULL}`);
check("flash rect n=0.22 (plain, no rotation)", plain.n > FULL * 0.95, `px=${plain.n} vs full ${FULL}`);
check("flash rect not the broken partial (~4356)", glow.n !== BROKEN && plain.n !== BROKEN,
  `glow=${glow.n} plain=${plain.n}`);
// the rotated rect's bbox should span the quad's full diagonal extent
const [gx0, gx1, gy0, gy1] = glow.bbox;
check("rotated glow bbox reaches all four corners",
  gx1 - gx0 >= 108 && gy1 - gy0 >= 80, `bbox ${gx1 - gx0}x${gy1 - gy0}`);

if (fails) { console.log(`\nFLASH CHECKS FAILED: ${fails}`); process.exit(1); }
console.log("\nALL FLASH CHECKS PASSED");
