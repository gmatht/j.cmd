// ffmpeg v1 — media conversion via ffmpeg.wasm (browser)
//
// NAME
//      ffmpeg — convert media files (ffmpeg.wasm, browser only)
//
// SYNOPSIS
//      ffmpeg -i input.mp4 output.gif
//      ffmpeg -i input.mp4 -vf scale=320:240 output.mp4
//
// DESCRIPTION
//      Runs the official ffmpeg.wasm (@ffmpeg/ffmpeg + @ffmpeg/core,
//      loaded from a CDN on first use) with the shell's files bridged
//      into ffmpeg's in-memory filesystem. Inputs are existing VFS
//      files (or -i FILE); the output is the last argument. Output is
//      written back to the VFS, so 'play output.mp4' / 'cat out.png'
//      work right after. Requires a browser + network (the core is
//      ~30MB, fetched once).
//
// EXAMPLES
//      ffmpeg -i /home/input.mp4 -vf scale=320:240 /home/out.gif
//      ffmpeg -i /home/in.webm -c:v libx264 /home/out.mp4

if (typeof document === "undefined") {
  console.log("ffmpeg: requires a browser (the ffmpeg.wasm core is Emscripten-glued and cannot run under the CLI's WASI host)");
  return 1;
}

var inputFiles = [];
var outName = null;
var i = 0;
var args2 = [];
var last = args[args.length - 1];
// Identify inputs: explicit -i FILE, or any existing VFS file arg.
// Everything else passes through; the LAST arg is the output name.
while (i < args.length) {
  var a = args[i];
  if (a === "-i" && i + 1 < args.length) {
    inputFiles.push(args[i + 1]);
    args2.push("-i", "in" + inputFiles.length + "_" + (args[i + 1].split("/").pop() || "in" + inputFiles.length));
    i += 2;
    continue;
  }
  var isFile = false;
  if (a.charAt(0) !== "-") {
    try { var st = await fs.stat(a); isFile = st && st.type === "file"; } catch (e) {}
  }
  if (isFile) {
    inputFiles.push(a);
    args2.push("in" + inputFiles.length + "_" + (a.split("/").pop() || "in" + inputFiles.length));
  } else {
    args2.push(a);
  }
  i++;
}
if (inputFiles.length === 0 || !last || last.charAt(0) === "-") {
  console.log("ffmpeg: usage: ffmpeg -i input.mp4 [opts] output.mp4");
  return 2;
}
outName = last.split("/").pop() || last;
// The output name in ffmpeg's memory fs is the bare basename — rewrite
// the last arg so ffmpeg writes where readFile will look.
args2[args2.length - 1] = outName;

var log = [];
try {
  // Load the official wrapper + core from a CDN (cached after first use).
  var mod = await import("https://esm.sh/@ffmpeg/ffmpeg@0.12.15");
  var util = await import("https://esm.sh/@ffmpeg/util@0.12.2");
  var ffmpeg = new mod.FFmpeg();
  ffmpeg.on("log", function (msg) { log.push((msg && msg.message ? msg.message : msg) + "\n"); });
  await ffmpeg.load({
    coreURL: await util.toBlobURL("https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js", "text/javascript"),
    wasmURL: await util.toBlobURL("https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm", "application/wasm"),
  });
  // Bridge inputs: read each VFS file into ffmpeg's memory fs.
  for (var f = 0; f < inputFiles.length; f++) {
    var blob = await fs.readBlob(inputFiles[f]);
    var data = new Uint8Array(await blob.arrayBuffer());
    await ffmpeg.writeFile("in" + (f + 1) + "_" + (inputFiles[f].split("/").pop() || "in" + (f + 1)), data);
  }
  await ffmpeg.exec(args2);
  var outData = await ffmpeg.readFile(outName);
  var outBytes = outData instanceof Uint8Array ? outData : new Uint8Array(outData);
  var outPath = typeof fs._resolve === "function" ? fs._resolve(last) : last;
  await fs.writeBlob(outPath, new Blob([outBytes]));
  console.log("ffmpeg: " + last + " (" + outBytes.length + " bytes)");
  ffmpeg.terminate();
  return 0;
} catch (e) {
  console.log("ffmpeg: " + (e && e.message ? e.message : String(e)));
  if (log.length > 0) console.log(log.slice(-8).join(""));
  return 1;
}
