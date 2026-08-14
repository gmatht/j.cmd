import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { WasmRunner } from "./src/wasm.js";
import { qbe2wasm } from "./src/qbe2wasm.js";

// Replicates the shell's `cc` path: preprocess (strip #, inject decls),
// cproc.wasm → QBE IR, qbe2wasm → a.wasm, then run through WasmRunner.
const CPROC_DECLS =
  `int printf(const char*, ...);\nint puts(const char*);\nint putchar(int);\n` +
  `int fprintf(void*, const char*, ...);\nint sprintf(char*, const char*, ...);\n` +
  `void *malloc(unsigned long);\nvoid *calloc(unsigned long, unsigned long);\n` +
  `void *realloc(void*, unsigned long);\nvoid free(void*);\n` +
  `unsigned long strlen(const char*);\nint strcmp(const char*, const char*);\n` +
  `char *strcpy(char*, const char*);\nchar *strncpy(char*, const char*, unsigned long);\n` +
  `char *strcat(char*, const char*);\nvoid *memcpy(void*, const void*, unsigned long);\n` +
  `void *memmove(void*, const void*, unsigned long);\nvoid *memset(void*, int, unsigned long);\n` +
  `int memcmp(const void*, const void*, unsigned long);\nvoid exit(int);\nvoid abort(void);\n` +
  `typedef int (*qsort_cmp)(const void*, const void*);\n` +
  `void qsort(void*, unsigned long, unsigned long, qsort_cmp);\n` +
  `void *bsearch(const void*, const void*, unsigned long, unsigned long, qsort_cmp);\n`;

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
const prepped = CPROC_DECLS + src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
await fs.write("/tmp/qs.c", prepped);
await fs.writeBlob("/usr/bin/cproc.wasm", new Blob([readFileSync("www/wasm-bin/cproc.wasm")]));

const runner = new WasmRunner(fs);
await runner._ensureInit();
await runner.run("/usr/bin/cproc.wasm", ["cproc-qbe", "-t", "wasm64", "/tmp/qs.c"]);
if (runner.getExitCode() !== 0) {
  console.log("cproc FAILED:", runner.getStderr().slice(0, 500));
  process.exit(1);
}
const ir = runner.getStdout();
const bytes = qbe2wasm(ir, {});
console.log("qbe2wasm:", bytes.length, "bytes");

const module = new WebAssembly.Module(bytes);
console.log("imports:", JSON.stringify(WebAssembly.Module.imports(module).map((i) => i.module + "." + i.name)));
console.log("exports:", JSON.stringify(WebAssembly.Module.exports(module).map((e) => e.name)));

await fs.writeBlob("/tmp/qs.wasm", new Blob([bytes]));
await runner.run("/tmp/qs.wasm", ["qs"]);
console.log("run exit:", runner.getExitCode());
console.log("run stdout:", JSON.stringify(runner.getStdout()));
if (runner.getStdout().trim() !== ["apple", "banana", "fig", "pear"].join("\n")) {
  console.log("FAIL: not sorted correctly");
  process.exit(1);
}
console.log("PASS: qsort with C compar works end to end");
