import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { WasmRunner } from "./src/wasm.js";

const cases = {
  indirect: `int inc(int x){ return x+1; }\nint apply(int (*f)(int), int x) { return f(x); }\nint main(){ return apply(inc, 41); }\n`,
  store: `int inc(int x){ return x+1; }\nint main(){ int (*f)(int) = inc; return f(41); }\n`,
};
await fs.writeBlob("/usr/bin/cproc.wasm", new Blob([readFileSync("www/wasm-bin/cproc.wasm")]));
const runner = new WasmRunner(fs);
await runner._ensureInit();
for (const [name, src] of Object.entries(cases)) {
  await fs.write("/tmp/" + name + ".c", src);
  await runner.run("/usr/bin/cproc.wasm", ["cproc-qbe", "-t", "wasm64", "/tmp/" + name + ".c"]);
  console.log(`=== ${name}: exit=${runner.getExitCode()}`);
  console.log(runner.getStdout());
  console.log(runner.getStderr());
}
