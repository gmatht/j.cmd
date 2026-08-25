const OUT = "/root/src/sh2runtime/tmp/shots";
// Convert captured canvases to PNGs + compute similarity metrics
import { readFileSync, writeFileSync } from "fs";

function decode(jsonPath) {
  const d = JSON.parse(readFileSync(jsonPath, "utf8"));
  return { W: d.W, H: d.H, px: new Uint8Array(d.px) };
}
function writePng(path, img) {
  const { W, H, px } = img;
  // minimal PNG encoder (RGBA, no compression beyond zlib deflate)
  const zlib = require("zlib");
  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0; // filter none
    px.subarray(y * W * 4, (y + 1) * W * 4).forEach((v, i) => { raw[y * (W * 4 + 1) + 1 + i] = v; });
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = require("zlib").crc32 ? null : null;
    let c = 0;
    const crcBuf = Buffer.alloc(4);
    // CRC32
    const table = [];
    for (let n = 0; n < 256; n++) { let k = n; for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; table[n] = k >>> 0; }
    let crc = 0xffffffff;
    for (const b of Buffer.concat([Buffer.from(type), data])) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

const menu = readFileSync(OUT + "/settings-canvas.json", "utf8") ? JSON.parse(readFileSync(OUT + "/settings-canvas.json", "utf8")) : null;
const f1 = readFileSync(OUT + "/frame1-canvas.json", "utf8") ? JSON.parse(readFileSync(OUT + "/frame1-canvas.json", "utf8")) : null;
const menuImg = { W: menu.W, H: menu.H, px: new Uint8Array(menu.px) };
const f1Img = { W: f1.W, H: f1.H, px: new Uint8Array(f1.px) };
writePng(OUT + "/settings-canvas.png", menuImg);
writePng(OUT + "/frame1-canvas.png", f1Img);
console.log("PNGs written");

// ── similarity metrics ──
const W = menu.W, H = menu.H;
const a = menuImg.px, b = f1Img.px;
const N = W * H;
let identical = 0, close = 0, diff = 0;
const perRow = [];
for (let y = 0; y < H; y++) {
  let rowSame = 0;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) { identical++; rowSame++; }
    else {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (d < 30) diff++;
    }
  }
  rowSame > 0 && rowSame < W && rowSame > W * 0.5 ? null : null;
}
// region grid 8x6 (100x100 px each)
const RCOLS = 8, RROWS = 6;
const regions = [];
for (let ry = 0; ry < RROWS; ry++) {
  for (let rx = 0; rx < RCOLS; rx++) {
    let same = 0, tot = 0;
    for (let y = ry * (H / RROWS); y < (ry + 1) * (H / RROWS); y++) {
      for (let x = rx * (W / RCOLS); x < (rx + 1) * (W / RCOLS); x++) {
        const i = (Math.floor(y) * W + Math.floor(x)) * 4;
        tot++;
        if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) same++;
      }
    }
    regions.push({ col: rx, row: ry, samePct: (same / tot * 100).toFixed(1) });
  }
}
console.log(JSON.stringify({
  size: W + "x" + H,
  identicalPct: (identical / (W * H) * 100).toFixed(2),
  nearPct: ((identical + diff) / (W * H) * 100).toFixed(2),
  regions,
}, null, 1));
