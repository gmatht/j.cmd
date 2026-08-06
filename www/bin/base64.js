// base64 v1 — encode/decode base64 (RFC 4648).
//   echo hello | base64        encode stdin
//   base64 file.txt            encode a file
//   base64 -d                  decode (stdin or file)
//   base64 -w 0                no line wrapping (default 76 columns)
//   base64 -h                  help
var NL = String.fromCharCode(10);

var B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64encode(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += B64CHARS[b0 >> 2];
    out += B64CHARS[((b0 & 3) << 4) | (i + 1 < bytes.length ? b1 >> 4 : 0)];
    out += i + 1 < bytes.length ? B64CHARS[((b1 & 15) << 2) | (i + 2 < bytes.length ? b2 >> 6 : 0)] : "=";
    out += i + 2 < bytes.length ? B64CHARS[b2 & 63] : "=";
  }
  return out;
}

function b64decode(text) {
  var inv = {};
  for (var i = 0; i < B64CHARS.length; i++) inv[B64CHARS[i]] = i;
  var clean = String(text).replace(/[^A-Za-z0-9+/=]/g, "");
  var bytes = [];
  var buf = 0, bits = 0;
  for (var c = 0; c < clean.length; c++) {
    var ch = clean[c];
    if (ch === "=") break;
    if (inv[ch] === undefined) continue;
    buf = (buf << 6) | inv[ch];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 255);
    }
  }
  return bytes;
}

function usage() {
  console.log("base64 — encode or decode base64 (RFC 4648)");
  console.log("  base64 [FILE]         encode FILE (or stdin)");
  console.log("  base64 -d [FILE]      decode");
  console.log("  base64 -w N           wrap output at N columns (0 = none, default 76)");
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
    if (isNaN(wrap) || wrap < 0) { console.log("base64: invalid wrap '" + args[i] + "'"); return 2; }
  }
  else if (a === "-h" || a === "--help") { usage(); return 0; }
  else rest.push(a);
}
var input = null;
if (rest.length > 0) {
  try { input = await fs.read(rest[0]); }
  catch (e) { console.log("base64: " + rest[0] + ": " + (e && e.message ? e.message : e)); return 1; }
} else {
  input = stdin;
}
if (!input) { usage(); return 2; }

var out;
if (decode) {
  out = new TextDecoder().decode(new Uint8Array(b64decode(input)));
} else {
  var encoded = b64encode(new TextEncoder().encode(input));
  if (wrap > 0) {
    var wrapped = "";
    for (var k = 0; k < encoded.length; k += wrap) wrapped += encoded.slice(k, k + wrap) + NL;
    encoded = wrapped;
  }
  out = encoded;
}
console.log(out);
return 0;
