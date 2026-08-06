// qbe2wasm v2 — QBE IR -> wasm binary. In-shell C backend.
// Compiles QBE IL text (as emitted by cproc: cproc-qbe -o out.qbe prog.c)
// into a WebAssembly binary. The engine is injected by the shell.
//
//   qbe2wasm file.qbe               writes a.wasm (like gcc's a.out)
//   qbe2wasm -o out.wasm file.qbe   writes out.wasm
//   qbe2wasm -w -o out.wasm file.qbe  memory64 module (addresses > 4GiB)
//   cat prog.qbe | qbe2wasm -o out.wasm
//
// SEE ALSO
//   man qbe2wasm
let outFile = "a.wasm";
let wasm64 = false;
let src = null;
const resolve = (p) => (p.startsWith("/") ? p : (fs._resolve ? fs._resolve(p) : p));
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-o" || a === "--output") {
    i++;
    outFile = resolve(args[i]);
  } else if (a === "-w" || a === "--wasm64") {
    wasm64 = true;
  } else if (a === "-h" || a === "--help") {
    console.log("usage: qbe2wasm [-o out.wasm] [-w] [file.qbe]");
    console.log("  compiles QBE IL (cproc output) to a wasm binary.");
    console.log("  reads stdin when no file is given. -w selects memory64.");
    return 0;
  } else if (src === null && !a.startsWith("-")) {
    src = resolve(a);
  } else {
    console.log("qbe2wasm: unknown option '" + a + "'");
    return 1;
  }
}
let ir;
if (src !== null) {
  ir = await fs.read(src);
} else if (stdin) {
  ir = stdin;
} else {
  console.log("qbe2wasm: no input (give a .qbe file or pipe QBE IR on stdin)");
  return 1;
}
try {
  const bytes = qbe2wasm(ir, { wasm64: wasm64 });
  await fs.writeBlob(outFile, new Blob([bytes], { type: "application/wasm" }));
  console.log(outFile + ": " + bytes.length + " bytes");
  return 0;
} catch (e) {
  throw e;
}
