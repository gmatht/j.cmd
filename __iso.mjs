import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { WasmRunner } from "./src/wasm.js";
import { qbe2wasm, parseIr } from "./src/qbe2wasm.js";

const cases = {
  fnptr: `void qsort(void*, unsigned long, unsigned long, void*);\nint cmp(const void *a, const void *b){ return 0; }\nint main(){ qsort(0, 1, 2, cmp); return 0; }\n`,
  nofnptr: `void qsort(void*, unsigned long, unsigned long, void*);\nint main(){ qsort(0, 1, 2, 0); return 0; }\n`,
};
await fs.writeBlob("/usr/bin/cproc.wasm", new Blob([readFileSync("www/wasm-bin/cproc.wasm")]));
const runner = new WasmRunner(fs);
await runner._ensureInit();
for (const [name, src] of Object.entries(cases)) {
  await fs.write("/tmp/" + name + ".c", src);
  await runner.run("/usr/bin/cproc.wasm", ["cproc-qbe", "-t", "wasm64", "/tmp/" + name + ".c"]);
  const ir = runner.getStdout();
  console.log(`=== ${name}: exit=${runner.getExitCode()} stderr=${JSON.stringify(runner.getStderr().slice(0,200))}`);
  console.log(ir);
  try { parseIr(ir); console.log("parseIr: OK"); } catch (e) { console.log("parseIr FAILED:", e.message); }
  try { const b = qbe2wasm(ir, {}); console.log("qbe2wasm: OK", b.length, "bytes"); } catch (e) { console.log("qbe2wasm FAILED:", e.message); }
}
