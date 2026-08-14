// __corr5.mjs — render the corridor + the blocks IMMEDIATELY left/right
// of the player (cells (4,2) and (6,2)) to inspect their "2d" look.
const W = 140, H = 46;
const aPos = new Float32Array("-0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 -0.5 0.5 -0.5 -0.5 -0.5 0.5 0.5 -0.5 0.5 0.5 -0.5 -0.5 -0.5 -0.5 -0.5 -0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 -0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 -0.5 -0.5 -0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 -0.5 0.5 -0.5 -0.5".split(/\s+/).map(Number));
const cubeI = [0,1,2,0,2,3,4,5,6,4,6,7,8,9,10,8,10,11,12,13,14,12,14,15,16,17,18,16,18,19,20,21,22,20,22,23];
const P = 0.45;

function render(blocks, eye, yawDeg) {
  const depth = new Float32Array(W * H).fill(1.0);
  const pix = new Array(W * H).fill(".");
  const a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const chOf = (line) => {
    const n = line.trim().split(/\s+/).map(Number);
    const tx = n[9], b = n[3];
    if (b === 40) return "=";
    if (tx === 1) return "#";          // stone
    if (tx === 10) return "O";         // obsidian
    return "d";                        // dirt
  };
  const draw = (payload, writeDepth) => {
    for (const line of payload.split("\n")) {
      const n = line.trim().split(/\s+/).map(Number);
      if (n.length < 3) continue;
      const ch = chOf(line);
      const [x, y, z, sx, sy, sz] = n;
      for (let t = 0; t < 12; t++) {
        const i0 = cubeI[t*3], i1 = cubeI[t*3+1], i2 = cubeI[t*3+2];
        const clip = [[i0],[i1],[i2]].map(([v]) => {
          const px = aPos[v*3]*sx + x, py = aPos[v*3+1]*sy + y, pz = aPos[v*3+2]*sz + z;
          const d = [px-eye[0], py-eye[1], pz-eye[2]];
          const rel = [d[0]*c + d[2]*s, d[1], -d[0]*s + d[2]*c];
          const w = -rel[2];
          return { x: rel[0]*P, y: rel[1]*P, z: w*w/64.0, w };
        });
        const poly = [];
        for (let i = 0; i < clip.length; i++) {
          const v0 = clip[i], v1 = clip[(i+1) % clip.length];
          const in0 = v0.w > 0, in1 = v1.w > 0;
          if (in0) poly.push(v0);
          if (in0 !== in1) { const tt = v0.w / (v0.w - v1.w); poly.push({ x: v0.x + tt*(v1.x-v0.x), y: v0.y + tt*(v1.y-v0.y), z: v0.z + tt*(v1.z-v0.z), w: 0 }); }
        }
        if (poly.length < 3) continue;
        for (let i = 1; i < poly.length - 1; i++) {
          const ndc = [poly[0], poly[i], poly[i+1]].map((v) => ({
            x: v.w === 0 ? (v.x === 0 ? 0 : (v.x > 0 ? 1e6 : -1e6)) : v.x / v.w,
            y: v.w === 0 ? (v.y === 0 ? 0 : (v.y > 0 ? 1e6 : -1e6)) : v.y / v.w,
            d: v.w === 0 ? 0.5 : (v.z / v.w + 1) / 2,
          }));
          let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
          for (const v of ndc) { minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); }
          if (maxX < -1 || minX > 1 || maxY < -1 || minY > 1) continue;
          const sx0 = Math.max(0, Math.floor((minX + 1) / 2 * W)), sx1 = Math.min(W - 1, Math.ceil((maxX + 1) / 2 * W));
          const sy0 = Math.max(0, Math.floor((1 - maxY) / 2 * H)), sy1 = Math.min(H - 1, Math.ceil((1 - minY) / 2 * H));
          const area = (v0, v1, v2) => (v1.x - v0.x) * (v2.y - v0.y) - (v1.y - v0.y) * (v2.x - v0.x);
          const A = area(ndc[0], ndc[1], ndc[2]);
          if (Math.abs(A) < 1e-9) continue;
          for (let py = sy0; py <= sy1; py++) {
            const ndcY = 1 - (py + 0.5) / H * 2;
            for (let px = sx0; px <= sx1; px++) {
              const ndcX = (px + 0.5) / W * 2 - 1;
              const p = { x: ndcX, y: ndcY };
              const a0 = area(ndc[1], ndc[2], p), a1 = area(ndc[2], ndc[0], p), a2 = area(ndc[0], ndc[1], p);
              const s0 = a0 / A, s1 = a1 / A, s2 = a2 / A;
              if (s0 < -1e-6 || s1 < -1e-6 || s2 < -1e-6) continue;
              const dd = s0 * ndc[0].d + s1 * ndc[1].d + s2 * ndc[2].d;
              const idx = py * W + px;
              if (dd <= depth[idx]) { if (writeDepth) depth[idx] = dd; pix[idx] = ch; }
            }
          }
        }
      }
    }
  };
  draw(bg, false);
  for (const l of blocks.split("\n")) draw(l, true);
  return pix;
}

// the corridor scene: player (5,2) facing -z, eye y=1.0 (the current fix)
const eye = [5, 1.0, 2];
const bg = "5 -0.05 2 40 0.1 40 0.45 0.40 0.34 0 0\n5 2.05 2 40 0.1 40 0.24 0.24 0.28 0 0";
const blocks = [];
for (let z = 0; z < 16; z++) {
  for (let x = 0; x < 16; x++) {
    const adz = Math.abs(z - 2), adx = Math.abs(x - 5);
    if (adz > 16 || adx > 16) continue;
    if (adx > adz + (adz >> 1) + 1) continue;
    if (z >= 2) continue;
    // dirt ground everywhere, stone walls at x=3,x=7, obsidian border ring
    const isBorder = (x === 0 || x === 15 || z === 0 || z === 15);
    if (isBorder) { blocks.push(`${x} 0 ${z} 1 1 1 0.55 0.50 0.70 10 0`); blocks.push(`${x} 1 ${z} 1 1 1 0.55 0.50 0.70 10 0`); }
    else blocks.push(`${x} 0 ${z} 1 1 1 0.55 0.35 0.20 0 0`);
    if (x === 3 || x === 7) blocks.push(`${x} 1 ${z} 1 1 1 0.55 0.55 0.58 1 0`);
  }
}
const pix = render(blocks.join("\n"), eye, 0);
console.log(`corridor eye y=1.0 — '#'=stone 'd'=dirt 'O'=obsidian '='=bg — the blocks at (4,2) LEFT and (6,2) RIGHT of the player`);
for (let py = 0; py < H; py++) console.log(pix.slice(py*W, (py+1)*W).join(""));
