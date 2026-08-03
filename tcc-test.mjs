import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { WasmRunner } from "./src/wasm.js";

// Compile hello.c with the wasm tcc (wasm-bin/tcc.wasm + headers staged
// into /tmp/tcc/include) and run the resulting module end to end.
await fs.write("/home/hello.c", "int main() { return 6*7; }\n");
await fs.writeBlob("/usr/bin/tcc.wasm", new Blob([readFileSync("www/wasm-bin/tcc.wasm")]));

const runner = new WasmRunner(fs);
await runner._ensureInit();
const { ensureTccHeaders } = await import("./src/tcc.js");
const fetchBundle = async (rel) =>
  new Uint8Array(readFileSync("www/" + rel));
await ensureTccHeaders(fs, fetchBundle);

await runner.run("/usr/bin/tcc.wasm", ["tcc", "-c", "/home/hello.c", "-o", "/home/hello.wasm"]);
console.log("=== tcc exit:", runner.getExitCode(), "===");
console.log("=== tcc stderr:", JSON.stringify(runner.getStderr().slice(0, 300)), "===");

const out = await fs.readBlob("/home/hello.wasm");
const m = new WebAssembly.Module(new Uint8Array(await out.arrayBuffer()));
const i = new WebAssembly.Instance(m, { wasi_snapshot_preview1: { fd_write: () => 0, proc_exit: () => {} } });
console.log("=== compiled hello.wasm main() =", i.exports.main(), "===");
