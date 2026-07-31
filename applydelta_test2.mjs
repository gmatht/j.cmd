import zlib from "node:zlib";
import { readFileSync } from "node:fs";
const pack = new Uint8Array(readFileSync("/tmp/deltapack.pack"));
const delta = new Uint8Array(zlib.inflateSync(pack.subarray(1358, 1395)));
const base = new Uint8Array(zlib.inflateSync(pack.subarray(1181, 1354)));
console.log("delta hex:", Buffer.from(delta).toString("hex"));
console.log("delta len:", delta.length, "base len:", base.length);

function readLEB128(buf, st) {
  let result = 0, shift = 0, b;
  do { b = buf[st.i++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return result;
}
const st = { i: 0 };
const bs = readLEB128(delta, st);
const rs = readLEB128(delta, st);
console.log("baseSize:", bs, "resultSize:", rs, "st.i:", st.i);
const out = new Uint8Array(rs);
let o = 0;
while (st.i < delta.length) {
  const op = delta[st.i++];
  if (op & 0x80) {
    let ofs = 0, size = 0;
    if (op & 0x01) ofs |= delta[st.i++];
    if (op & 0x02) ofs |= delta[st.i++] << 8;
    if (op & 0x04) ofs |= delta[st.i++] << 16;
    if (op & 0x08) ofs |= delta[st.i++] << 24;
    if (op & 0x10) size |= delta[st.i++];
    if (op & 0x20) size |= delta[st.i++] << 8;
    if (op & 0x40) size |= delta[st.i++] << 16;
    if (op & 0x80) size |= delta[st.i++] << 24;
    if (size === 0) size = 0x10000;
    console.log(`copy op=${op.toString(16)} ofs=${ofs} size=${size} o=${o} st.i=${st.i}`);
    out.set(base.subarray(ofs, ofs + size), o);
    o += size;
  } else if (op > 0) {
    console.log(`literal op=${op} o=${o} st.i=${st.i} srcLen=${delta.subarray(st.i, st.i + op).length}`);
    out.set(delta.subarray(st.i, st.i + op), o);
    st.i += op;
    o += op;
  }
}
console.log("final o:", o, "resultSize:", rs);
