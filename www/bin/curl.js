// curl v1 — transfer data from URLs (fetch-based)
//
// NAME
//      curl — transfer data from URLs
//
// SYNOPSIS
//      curl [-o FILE] [-I] [-s] URL
//
// DESCRIPTION
//      curl fetches a URL with the browser/Node fetch API. Without -o
//      the response body is printed; -o saves it to a file (binary
//      safe). In the browser, CORS applies (the same restriction as
//      the /http mount).
//
// OPTIONS
//      -o FILE    save the response body to FILE
//      -I, --head show response headers only
//      -s, --silent  no progress line when saving
//      -h, --help show this help
//
// EXAMPLES
//      curl https://example.com
//      curl -o /home/logo.png https://example.com/logo.png
//      curl -I https://example.com

var url = null;
var outFile = null;
var headersOnly = false;
var silent = false;
var i = 0;
while (i < args.length) {
  var a = args[i];
  if (a === "-h" || a === "--help") {
    console.log("curl — transfer data from URLs");
    console.log("usage: curl [-o FILE] [-I] [-s] URL");
    console.log("example: curl https://example.com · curl -o /home/f.png URL");
    return 0;
  }
  if (a === "-o") { outFile = args[i + 1]; i += 2; continue; }
  if (a === "-I" || a === "--head") { headersOnly = true; i++; continue; }
  if (a === "-s" || a === "--silent") { silent = true; i++; continue; }
  url = a;
  i++;
}
if (!url) {
  console.log("curl — transfer data from URLs");
  console.log("usage: curl [-o FILE] [-I] [-s] URL");
  console.log("example: curl https://example.com");
  return 2;
}

var resp;
try {
  resp = await fetch(url, { method: headersOnly ? "HEAD" : "GET" });
} catch (e) {
  console.log("curl: " + url + ": " + (e && e.message ? e.message : String(e)));
  return 1;
}

if (headersOnly) {
  console.log("HTTP/" + resp.status + " " + resp.statusText);
  if (resp.headers && resp.headers.forEach) {
    resp.headers.forEach(function (v, k) { console.log(k + ": " + v); });
  }
  return 0;
}
if (!resp.ok) {
  console.log("curl: " + url + ": HTTP " + resp.status + " " + resp.statusText);
  return 1;
}

if (outFile) {
  var blob = await resp.blob();
  var dest = typeof fs._resolve === "function" ? fs._resolve(outFile) : outFile;
  await fs.writeBlob(dest, blob);
  if (!silent) console.log("curl: saved " + blob.size + " bytes to " + outFile);
} else {
  var text = await resp.text();
  if (text) console.log(text);
}
return 0;
