import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { WasmRunner } from "./src/wasm.js";
import { qbe2wasm } from "./src/qbe2wasm.js";

const CPROC_DECLS =
  `int printf(const char*, ...);\n` +
  `int puts(const char*);\n` +
  `int putchar(int);\n` +
  `int fprintf(void*, const char*, ...);\n` +
  `int sprintf(char*, const char*, ...);\n` +
  `void *malloc(unsigned long);\n` +
  `void *calloc(unsigned long, unsigned long);\n` +
  `void *realloc(void*, unsigned long);\n` +
  `void free(void*);\n` +
  `unsigned long strlen(const char*);\n` +
  `int strcmp(const char*, const char*);\n` +
  `char *strcpy(char*, const char*);\n` +
  `char *strncpy(char*, const char*, unsigned long);\n` +
  `char *strcat(char*, const char*);\n` +
  `void *memcpy(void*, const void*, unsigned long);\n` +
  `void *memmove(void*, const void*, unsigned long);\n` +
  `void *memset(void*, int, unsigned long);\n` +
  `int memcmp(const void*, const void*, unsigned long);\n` +
  `void exit(int);\n` +
  `void abort(void);\n`;

const src = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef int (*qsort_cmp)(const void*, const void*);
void qsort(void*, unsigned long, unsigned long, qsort_cmp);
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
const body = src.split("\n").filter(l => !l.trim().startsWith("#")).join("\n");
const prepped = body.includes("int printf(") ? body : CPROC_DECLS + body;
await fs.write("/tmp/qs.c", prepped);
await fs.writeBlob("/usr/bin/cproc.wasm", new Blob([readFileSync("www/wasm-bin/cproc.wasm")]));

const runner = new WasmRunner(fs);
await runner._ensureInit();
await runner.run("/usr/bin/cproc.wasm", ["cproc-qbe", "-t", "wasm64", "/tmp/qs.c"]);
console.log("cproc exit:", runner.getExitCode());
const ir = runner.getStdout();
if (runner.getExitCode() !== 0) { console.log("cproc stderr:", runner.getStderr().slice(0,500)); process.exit(0); }
// Show how cmp and qsort appear in the IR
const lines = ir.split("\n");
console.log("--- QBE IR (qsort/cmp related) ---");
for (const l of lines) if (/qsort|cmp|call/.test(l)) console.log(l);
try {
  const bytes = qbe2wasm(ir, {});
  await fs.writeBlob("/tmp/qs.wasm", new Blob([bytes]));
  const module = new WebAssembly.Module(bytes);
  console.log("--- wasm imports:", JSON.stringify(WebAssembly.Module.imports(module)));
  console.log("--- wasm exports:", JSON.stringify(WebAssembly.Module.exports(module).map(e=>e.name)));
} catch (e) {
  console.log("qbe2wasm FAILED:", e.message);
}
