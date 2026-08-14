import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { WasmRunner } from "./src/wasm.js";
import { qbe2wasm } from "./src/qbe2wasm.js";

const DECLS = `int puts(const char*);\nint printf(const char*, ...);\nint strcmp(const char*, const char*);\nvoid exit(int);\nvoid *malloc(unsigned long);\nvoid free(void*);\n` +
  `typedef int (*qsort_cmp)(const void*, const void*);\nvoid qsort(void*, unsigned long, unsigned long, qsort_cmp);\n` +
  `void *bsearch(const void*, const void*, unsigned long, unsigned long, qsort_cmp);\n`;

const cases = {
  "indirect-call": DECLS + `
int inc(int x) { return x + 1; }
int apply(int (*f)(int), int x) { return f(x); }
int main() { return apply(inc, 41); }
`,
  "store-indirect": DECLS + `
int inc(int x) { return x + 1; }
int main() { int (*f)(int) = inc; return f(41); }
`,
  "bsearch": DECLS + `
int cmp(const void *a, const void *b) { return strcmp(*(char**)a, *(char**)b); }
int main() {
  char *w[] = { "apple", "banana", "fig", "pear" };
  char *key = "fig";
  char **hit = (char**)bsearch(&key, w, 4, sizeof(char*), cmp);
  puts(hit ? *hit : "(null)");
  key = "kiwi";
  hit = (char**)bsearch(&key, w, 4, sizeof(char*), cmp);
  puts(hit ? *hit : "(null)");
  return 0;
}
`,
};

await fs.writeBlob("/usr/bin/cproc.wasm", new Blob([readFileSync("www/wasm-bin/cproc.wasm")]));
const runner = new WasmRunner(fs);
await runner._ensureInit();

for (const [name, src] of Object.entries(cases)) {
  const prepped = DECLS + src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  await fs.write("/tmp/" + name + ".c", prepped);
  await runner.run("/usr/bin/cproc.wasm", ["cproc-qbe", "-t", "wasm64", "/tmp/" + name + ".c"]);
  if (runner.getExitCode() !== 0) { console.log(`=== ${name}: cproc FAILED ${runner.getStderr().slice(0,300)}`); continue; }
  let bytes, exports;
  try {
    bytes = qbe2wasm(runner.getStdout(), {});
    exports = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((e) => e.name);
  } catch (e) { console.log(`=== ${name}: qbe2wasm FAILED: ${e.message}`); continue; }
  await fs.writeBlob("/tmp/" + name + ".wasm", new Blob([bytes]));
  try {
    await runner.run("/tmp/" + name + ".wasm", [name]);
    console.log(`=== ${name}: exit=${runner.getExitCode()} stdout=${JSON.stringify(runner.getStdout().trim())} exports=[${exports}]`);
  } catch (e) {
    console.log(`=== ${name}: RUN FAILED: ${e.message}`);
  }
}
