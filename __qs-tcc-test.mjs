import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { WasmRunner } from "./src/wasm.js";

const src = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int cmp(const void *a, const void *b) {
  const char *sa = *(const char *const *)a;
  const char *sb = *(const char *const *)b;
  return strcmp(sa, sb);
}
int main() {
  const char *words[] = { "pear", "apple", "fig", "banana" };
  qsort(words, 4, sizeof(char *), cmp);
  for (int i = 0; i < 4; i++) puts(words[i]);
  return 0;
}
`;
await fs.write("/home/qs.c", src);
await fs.writeBlob("/usr/bin/tcc.wasm", new Blob([readFileSync("www/wasm-bin/tcc.wasm")]));
const runner = new WasmRunner(fs);
await runner._ensureInit();
const { ensureTccHeaders } = await import("./src/tcc.js");
await ensureTccHeaders(fs, async (rel) => new Uint8Array(readFileSync("www/" + rel)));
await runner.run("/usr/bin/tcc.wasm", ["tcc", "-c", "/home/qs.c", "-o", "/home/qs.wasm"]);
console.log("tcc exit:", runner.getExitCode(), "stderr:", JSON.stringify(runner.getStderr().slice(0,300)));
if (runner.getExitCode() !== 0) process.exit(0);
await fs.writeBlob("/tmp/qs-tcc.wasm", await fs.readBlob("/home/qs.wasm"));
console.log("wrote /tmp/qs-tcc.wasm");
