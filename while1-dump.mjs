import { readFileSync } from "fs";
import { fs } from "/root/src/sh2runtime/src/fs/index.js";
import { WasmRunner } from "/root/src/sh2runtime/src/wasm.js";
import wabtPkg from "wabt";

const src = `int main(){ while(1){} return 0; }`;
await fs.write("/tmp/tc.c", src);
await fs.writeBlob("/usr/bin/tcc.wasm", new Blob([readFileSync("/root/src/sh2runtime/www/wasm-bin/tcc.wasm")]));
const runner = new WasmRunner(fs);
await runner._ensureInit();
await runner.run("/usr/bin/tcc.wasm", ["tcc", "-c", "/tmp/tc.c", "-o", "/home/o.wasm"]);
const bytes = new Uint8Array(await (await fs.readBlob("/home/o.wasm")).arrayBuffer());
console.log("size:", bytes.length);
const wabt = await wabtPkg();
try {
  const parsed = wabt.readWasm(bytes, { readDebugNames: true, features: { multi_memory: true } });
  console.log(parsed.toText({ foldExprs: false }));
} catch (e) {
  console.log("wabt failed to parse (module invalid):", e.message.slice(0, 120));
}
