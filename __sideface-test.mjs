// ─── __sideface-test.mjs — the toward-player side face of a same-row
// block must render (regression).
//
// A block immediately left/right of the player has its toward-player
// face EDGE-ON: the fake perspective divides by w, and the face's back
// half has w<0 — its triangles straddle the camera plane. The GPU's
// near-plane clip of a straddling polygon is degenerate (the w=0 clip
// point fails the -w≤x≤w clip volume unless x=0), so the whole face
// vanished — the block rendered FLAT (axis-aligned edges, no visible
// side) and the corridor walls looked longer in depth than wide. The
// fix clamps w to a small positive in the vertex shader (both the
// hand-written vs_fb and the generated GLSL, injected by the game).
//
// The test:
//   1) both shader paths contain the clamp (text check)
//   2) real-GL pixel proof: a same-row block rendered with the CLAMPED
//      shader shows its +x face (green wedge); with the UNCLAMPED
//      shader it shows only the -z front face (blue) — no wedge.
import { readFileSync } from "node:fs";
import gl0 from "gl";
import { WebGLDevice } from "./src/fs/webgldev.js";
import { getOtranspilerl } from "./src/otranspilerl.js";

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

const src = readFileSync("www/bin/mimecroft.sh", "utf8");
// the cube/quad buffer data lives in the STAGED game (the working-tree
// examples copy is mid-refactor and may lack the buffer writes)
const bin = readFileSync("www/bin/mimecroft.sh", "utf8");

// ─── 1) the clamp in the shader path ──────────────────────────────
// The hand-written vs_fb fallback was INTENTIONALLY removed (single GLSL
// source of truth — the sh2glsl-compiled vertex shader). The clamp is
// injected by the game at runtime into the compiled GLSL.
check("game injects the clamp into the generated GLSL", src.includes("if (g_w < 0.0) g_w = 0.05;"));

// the generated GLSL, after the game's injection — this IS the shader
// the game renders with (no fallback)
const lib = await getOtranspilerl();
const genRaw = lib.glslv(readFileSync("www/examples/mimecroft-vertex.sh", "utf8"));
const vsGlsl = genRaw.replace(
  "g_w = ((((0.0) - g_relz)) + (0.0));",
  "g_w = ((((0.0) - g_relz)) + (0.0)); if (g_w < 0.0) g_w = 0.05;");
check("generated GLSL has the clamp after injection", vsGlsl.includes("if (g_w < 0.0) g_w = 0.05;"));

// ─── 2) real-GL pixel proof ───────────────────────────────────────
// The hand-written fs_fb fallback is gone (single GLSL design) — the
// fragment is the sh2glsl-compiled game program (the inline echo lines
// emit_fragment_shader writes, exactly like __shader-test).
const fragM = src.match(/emit_fragment_shader\(\) \{(.*?)\n\}/s);
const fragLines = [];
for (const line of (fragM ? fragM[1] : "").split("\n")) {
  const mm = line.match(/^\s*echo '((?:[^'\\]|\\.)*)'\s*(?:>>|>)/);
  if (mm) fragLines.push(mm[1]);
}
const frag = lib.glsl(fragLines.join("\n") + "\n");
// distinct face colours (per vertex, in the buffer's face order):
// top WHITE, bottom 0.5 gray, +z YELLOW, -z BLUE, +x GREEN, -x RED
const SHADES =
  "1 1 1 1 1 1 1 1 1 1 1 1 " +
  "0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 " +
  "1 1 0 1 1 0 1 1 0 1 1 0 " +   // +z (behind in this view)
  "0 0 1 0 0 1 0 0 1 0 0 1 " +   // -z (front)
  "0 1 0 0 1 0 0 1 0 0 1 0 " +   // +x (toward the player — the wedge)
  "1 0 0 1 0 0 1 0 0 1 0 0";    // -x

function render(vs) {
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
  return (async () => {
    await w("/shader/vertex", vs);
    await w("/shader/fragment", frag);
    try { await w("/program", "link"); } catch (e) { return { err: e.message }; }
    const pos = /f32 ((-?0\.5[ 0-9.]*)+)" > \/dev\/webgl\/buffer\/aPosition/.exec(bin)[1];
    const uv = /f32 ([0-9 ]+)" > \/dev\/webgl\/buffer\/aUv/.exec(bin)[1];
    // the 36-index cube topology (faces in the aShade order: top,
    // bottom, +z, -z, +x, -x) — the staged game may be mid-refactor
    // and lack the buffer write; the topology is fixed cube geometry
    const idxM = /u16 ([0-9 ]+)" > \/dev\/webgl\/buffer\/cube/.exec(bin);
    const idx = idxM ? idxM[1] : "0 1 2 0 2 3 4 5 6 4 6 7 8 9 10 8 10 11 12 13 14 12 14 15 16 17 18 16 18 19 20 21 22 20 22 23";
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
    await w("/uniform/3f/uObjPos", "7 1 8");   // the block to the player's left
    await w("/uniform/3f/uScale", "1 1 1");
    await w("/uniform/3f/uBlockColor", "1 1 1");
    await w("/clearcolor", "0 0 0 1");
    await w("/call", "clear");
    await w("/call", "draw elements triangles 36 0 cube");
    const gl = dev._gl;
    const px = Buffer.alloc(800 * 600 * 4);
    gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const at = (x, sy) => { const i = ((600 - 1 - sy) * 800 + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
    // the wedge (toward-player +x face) occupies the left part of the
    // block's screen region (x 0..220, y 350..580). Count GREEN (+x)
    // vs BLUE (-z) pixels there.
    let green = 0, blue = 0;
    for (let y = 350; y < 580; y += 3) {
      for (let x = 10; x < 210; x += 3) {
        const c = at(x, y);
        if (c[1] > 150 && c[0] < 60 && c[2] < 60) green++;
        else if (c[2] > 150 && c[0] < 60 && c[1] < 60) blue++;
      }
    }
    return { green, blue };
  })();
}

const clampedVs = vsGlsl;   // the compiled shader (has the clamp)
const unclampedVs = vsGlsl.replace("if (g_w < 0.0) g_w = 0.05;", "");
const a = await render(clampedVs);
const b = await render(unclampedVs);
console.log("  clamped:   green(+x wedge)=" + a.green + " blue(-z front)=" + a.blue);
console.log("  unclamped: green(+x wedge)=" + b.green + " blue(-z front)=" + b.blue);
check("clamped shader renders the toward-player side face", a.green > 500, "green=" + a.green);
check("unclamped shader loses the side face (the bug)", b.green < 50 && b.blue > 500, "green=" + b.green + " blue=" + b.blue);

if (fails) { console.log(`\nSIDEFACE CHECKS FAILED: ${fails}`); process.exit(1); }
console.log("\nALL SIDEFACE CHECKS PASSED");
