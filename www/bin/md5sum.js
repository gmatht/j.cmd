// md5sum v1 — compute MD5 checksums
//
// NAME
//      md5sum — compute MD5 checksums
//
// SYNOPSIS
//      md5sum [file...]
//
// DESCRIPTION
//      Prints the MD5 digest of each file (or of stdin when no files
//      are given), in "hash  filename" form. Uses a bundled pure-JS
//      MD5 so it works identically in the browser and the CLI.
//
// EXAMPLES
//      md5sum /home/hello.txt
//      echo hi | md5sum

// ─── pure-JS MD5 (no dependencies; works in browser + Node) ───
function md5Hex(bytes) {
  var n = bytes.length;
  var padded = ((n + 9 + 63) >> 6) << 6;
  var buf = new Uint8Array(padded);
  buf.set(bytes);
  buf[n] = 0x80;
  var dv = new DataView(buf.buffer);
  dv.setUint32(padded - 8, (n << 3) >>> 0, true);
  dv.setUint32(padded - 4, Math.floor(n / 0x20000000), true);
  var s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
           5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
           4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
           6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  var K = [0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,
           0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
           0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,
           0x6b901122,0xfd987193,0xa679438e,0x49b40821,
           0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,
           0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
           0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,
           0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
           0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,
           0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
           0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,
           0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
           0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,
           0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
           0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,
           0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];
  var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  var M = new DataView(buf.buffer);
  for (var off = 0; off < padded; off += 64) {
    var A = a0, B = b0, C = c0, D = d0;
    for (var j = 0; j < 64; j++) {
      var f, g;
      if (j < 16) { f = (B & C) | (~B & D); g = j; }
      else if (j < 32) { f = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = B ^ C ^ D; g = (3 * j + 5) % 16; }
      else { f = C ^ (B | ~D); g = (7 * j) % 16; }
      var X = M.getUint32(off + g * 4, true);
      var tmp = D;
      D = C; C = B;
      var sum = (A + f + K[j] + X) >>> 0;
      var rot = (sum << s[j]) | (sum >>> (32 - s[j]));
      B = (B + rot) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  function hx(v) {
    // MD5 digests print each 32-bit word little-endian (lowest byte first)
    var s = ("0000000" + v.toString(16)).slice(-8);
    return s.slice(6, 8) + s.slice(4, 6) + s.slice(2, 4) + s.slice(0, 2);
  }
  return hx(a0) + hx(b0) + hx(c0) + hx(d0);
}

if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  console.log("md5sum — compute MD5 checksums");
  console.log("usage: md5sum [file...]   (stdin when no files)");
  console.log("example: md5sum /home/hello.txt");
  return args.length ? 0 : 2;
}

async function bytesOf(path) {
  var blob = await fs.readBlob(path);
  return new Uint8Array(await blob.arrayBuffer());
}
function hexOf(bytes) {
  var hex = "";
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i].toString(16);
    hex += b.length === 1 ? "0" + b : b;
  }
  return hex;
}

var hadError = false;
for (var i = 0; i < args.length; i++) {
  var path = typeof fs._resolve === "function" ? fs._resolve(args[i]) : args[i];
  var data;
  try { data = await bytesOf(path); }
  catch (e) {
    console.log("md5sum: " + args[i] + ": No such file or directory");
    hadError = true;
    continue;
  }
  console.log(md5Hex(data) + "  " + args[i]);
}
return hadError ? 1 : 0;
