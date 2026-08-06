// sha256sum v1 — compute SHA-256 checksums
//
// NAME
//      sha256sum — compute SHA-256 checksums
//
// SYNOPSIS
//      sha256sum [file...]
//
// DESCRIPTION
//      Prints the SHA-256 digest of each file (or of stdin when no
//      files are given), in "hash  filename" form. Uses the Web
//      Crypto API (crypto.subtle), which both the browser and Node
//      provide.
//
// EXAMPLES
//      sha256sum /home/hello.txt
//      echo hi | sha256sum

if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
  console.log("sha256sum — compute SHA-256 checksums");
  console.log("usage: sha256sum [file...]   (stdin when no files)");
  console.log("example: sha256sum /home/hello.txt");
  return args.length ? 0 : 2;
}

function toHex(bytes) {
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
  try {
    var blob = await fs.readBlob(path);
    var data = new Uint8Array(await blob.arrayBuffer());
    var digest = await crypto.subtle.digest("SHA-256", data);
    console.log(toHex(new Uint8Array(digest)) + "  " + args[i]);
  } catch (e) {
    console.log("sha256sum: " + args[i] + ": " + (e && e.message ? e.message : String(e)));
    hadError = true;
  }
}
return hadError ? 1 : 0;
