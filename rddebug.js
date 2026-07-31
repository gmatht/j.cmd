import { readFileSync } from "node:fs";
import zlib from "node:zlib";
const pack = new Uint8Array(readFileSync("/tmp/refdelta.pack"));
const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
const count = dv.getUint32(8, false);
console.log("pack len:", pack.length, "count:", count);

function readLEB128(buf, st) {
  let result = 0, shift = 0, b;
  do { b = buf[st.i++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return result;
}
function findEnd(start, expectedSize) {
  let lo = start + 1;
  let hi = Math.min(pack.length, start + Math.max(64, Math.ceil(expectedSize / 2)));
  const complete = (end) => {
    try { return zlib.inflateSync(pack.subarray(start, end)).length === expectedSize; } catch { return false; }
  };
  for (;;) {
    if (complete(hi)) break;
    const span = hi - start;
    if (hi >= pack.length || span >= pack.length - start) throw new Error("truncated at " + start);
    hi = Math.min(pack.length, start + Math.ceil(span * 1.5));
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (complete(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

let off = 12;
for (let n = 0; n < count; n++) {
  const entryOff = off;
  let c = pack[off++];
  const type = (c >> 4) & 7;
  let size = c & 0x0f, shift = 4;
  while (c & 0x80) { c = pack[off++]; size |= (c & 0x7f) << shift; shift += 7; }
  let baseOff = null, baseSha = null;
  if (type === 6) {
    c = pack[off++];
    let ofs = c & 0x7f;
    while (c & 0x80) { c = pack[off++]; ofs = ((ofs + 1) << 7) | (c & 0x7f); }
    baseOff = entryOff - ofs;
  } else if (type === 7) {
    baseSha = Buffer.from(pack.subarray(off, off + 20)).toString("hex");
    off += 20;
  }
  const compEnd = await findEnd(off, size);
  console.log(`entry ${n}: off=${entryOff} type=${type} size=${size} comp=${off}..${compEnd} baseOff=${baseOff} baseSha=${baseSha}`);
  off = compEnd;
}
console.log("final off:", off, "pack len:", pack.length);
