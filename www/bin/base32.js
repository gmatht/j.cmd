// base32 v1 — encode/decode base32 (RFC 4648, A-Z2-7).
//   echo hello | base32        encode stdin
//   base32 file.txt            encode a file
//   base32 -d                  decode (stdin or file)
//   base32 -w 0                no line wrapping (default 76 columns)
//   base32 -h                  help
var NL = String.fromCharCode(10);

var B32CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function b32encode(bytes) {
  var out = "";
  var buf = 0, bits = 0;
  for (var i = 0; i < bytes.length; i++) {
    buf = (buf << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32CHARS[(buf >> bits) & 31];
    }
  }
  if (bits > 0) out += B32CHARS[(buf << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += "=";
  return out;
}

function b32decode(text) {
  var inv = {};
  for (var i = 0; i < B32CHARS.length; i++) inv[B32CHARS[i]] = i;
  var clean = String(text).toUpperCase().replace(/[^A-Z2-7=]/g, "");
  var bytes = [];
  var buf = 0, bits = 0;
  for (var c = 0; c < clean.length; c++) {
    var ch = clean[c];
    if (ch === "=") break;
    if (inv[ch] === undefined) continue;
    buf = (buf << 5) | inv[ch];
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 255);
    }
  }
  return bytes;
}

function usage() {
  console.log("base32 — encode or decode base32 (RFC 4648)");
  console.log("  base32 [FILE]         encode FILE (or stdin)");
  console.log("  base32 -d [FILE]      decode");
  console.log("  base32 -w N           wrap output at N columns (0 = none, default 76)");
}

var decode = false;
var wrap = 76;
var rest = [];
for (var i = 0; i < args.length; i++) {
  var a = args[i];
  if (a === "-d" || a === "--decode") decode = true;
  else if (a === "-w" || a === "--wrap") {
    i++;
    wrap = parseInt(args[i], 10);
    if (isNaN(wrap) || wrap < 0) { console.log("base32: invalid wrap '" + args[i] + "'"); return 2; }
  }
  else if (a === "-h" || a === "--help") { usage(); return 0; }
  else rest.push(a);
}
var input = null;
if (rest.length > 0) {
  try { input = await fs.read(rest[0]); }
  catch (e) { console.log("base32: " + rest[0] + ": " + (e && e.message ? e.message : e)); return 1; }
} else {
  input = stdin;
}
if (!input) { usage(); return 2; }

var out;
if (decode) {
  out = new TextDecoder().decode(new Uint8Array(b32decode(input)));
} else {
  var encoded = b32encode(new TextEncoder().encode(input));
  if (wrap > 0) {
    var wrapped = "";
    for (var k = 0; k < encoded.length; k += wrap) wrapped += encoded.slice(k, k + wrap) + NL;
    encoded = wrapped;
  }
  out = encoded;
}
console.log(out);
return 0;
