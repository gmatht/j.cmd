// cproc's OWN test suite, run through the wasm export pipeline:
//   cproc.wasm (wasm32-wasi) → QBE IR → (qbe2wasm) → wasm module
//
// The suite is the vendored cproc source tree's `test/` directory
// (build/cproc-wasm/test): each `NAME.c` pairs with `NAME.qbe` (the
// expected QBE IR), `NAME.pp` (expected preprocessed output), or
// `NAME.err` (an expected compile refusal). This is exactly cproc's own
// `make test` protocol, except the compiler is the wasm binary the
// shell ships, not a native ELF.
//
// Part A — the IR/refusal comparisons (cproc's own pass definition).
// Part B — every passing IR is exported: qbe2wasm → WebAssembly.Module.
// Part C — a sample executes (hello, basic, struct-copy, …).
import { readFileSync, readdirSync, existsSync } from "fs";
import { fs } from "./src/fs/index.js";
import { WasmRunner } from "./src/wasm.js";
import { qbe2wasm } from "./src/qbe2wasm.js";

const runner = new WasmRunner(fs);
await runner._ensureInit();
await fs.writeBlob("/usr/bin/cproc.wasm", new Blob([readFileSync("www/wasm-bin/cproc.wasm")]));

const testDir = "build/cproc-wasm/test";
const files = [
  ...readdirSync(testDir).filter((f) => f.endsWith(".c")),
  ...readdirSync(testDir + "/constraint").filter((f) => f.endsWith(".c")).map((f) => "constraint/" + f),
];

const archOf = (name) => {
  const m = /\+([a-z0-9-]+)\.c$/.exec(name);
  return m ? m[1] : "x86_64-sysv";
};

let pass = 0, fail = 0, skip = 0;
const failed = [];
const passingIR = [];   // { name, ir } — for the export sweep

let n = 0;
for (const file of files) {
  const b = file.replace(/\.c$/, "");
  const arch = archOf(file);
  const srcPath = "/tmp/cs/c" + (n++) + ".c";
  await fs.write(srcPath, readFileSync(`${testDir}/${file}`, "utf8"));

  const wantQbe = `${testDir}/${b}.qbe`;
  const wantErr = `${testDir}/${b}.err`;
  const wantPp = `${testDir}/${b}.pp`;

  let ok = false;
  if (existsSync(wantQbe)) {
    await runner.run("/usr/bin/cproc.wasm", ["cproc-qbe", "-t", arch, srcPath]);
    const got = runner.getStdout();
    const want = readFileSync(wantQbe, "utf8");
    ok = runner.getExitCode() === 0 && got.trim() === want.trim();
    if (ok) passingIR.push({ name: file, ir: got });
  } else if (existsSync(wantErr)) {
    await runner.run("/usr/bin/cproc.wasm", ["cproc-qbe", "-t", arch, srcPath]);
    const got = runner.getStderr().trim().split(/\s+/).slice(1).join(" ");
    const want = readFileSync(wantErr, "utf8").trim();
    ok = runner.getExitCode() !== 0 && got === want;
  } else if (existsSync(wantPp)) {
    await runner.run("/usr/bin/cproc.wasm", ["cproc-qbe", "-t", arch, "-E", srcPath]);
    const got = runner.getStdout().trim();
    const want = readFileSync(wantPp, "utf8").trim();
    ok = runner.getExitCode() === 0 && got === want;
  } else {
    skip++;
    continue;
  }
  if (ok) pass++;
  else { fail++; failed.push(file); }
}

console.log(`\ncproc's own suite through the wasm binary: ${pass}/${pass + fail} passed, ${skip} skipped`);
if (failed.length) console.log("FAILED: " + failed.slice(0, 12).join(" ") + (failed.length > 12 ? " …" : ""));

// ── Part B — export every passing IR to a wasm module ─────────────
// (declaration-only tests emit no functions — nothing to run — so a
// "no functions in IR" refusal is correct, not a failure)
let exported = 0, exportFail = 0, declOnly = 0;
const exportBad = [];
for (const { name, ir } of passingIR) {
  try {
    const bytes = qbe2wasm(ir, {});
    new WebAssembly.Module(bytes);
    exported++;
  } catch (e) {
    const m = e.message || String(e);
    if (/no functions in IR/.test(m)) { declOnly++; continue; }
    exportFail++;
    if (exportBad.length < 8) exportBad.push(name + " (" + m.slice(0, 60) + ")");
  }
}
console.log(`export: ${exported}/${passingIR.length} passing IRs compile to a valid wasm module (${declOnly} declaration-only — nothing to run; ${exportFail} backend gaps)`);
if (exportBad.length) console.log("  export gaps: " + exportBad.join(" | "));

// ── Part C — a sample actually executes ───────────────────────────
const sample = ["hello.c", "basic.c", "struct-copy.c", "for-loop.c", "logical-and.c", "switch.c"];
let ran = 0, runFail = 0;
for (const name of sample) {
  const entry = passingIR.find((e) => e.name === name);
  if (!entry) continue;
  try {
    const bytes = qbe2wasm(entry.ir, {});
    const path = "/tmp/exec/" + name.replace(".c", ".wasm");
    await fs.writeBlob(path, new Blob([bytes]));
    const ex = new WasmRunner(fs);
    await ex._ensureInit();
    await ex.run(path, []);
    if (ex.getExitCode() === 0) ran++;
    else { runFail++; console.log(`  run ${name}: exit ${ex.getExitCode()} — ${JSON.stringify(ex.getStderr().slice(0, 120))}`); }
  } catch (e) {
    runFail++;
    console.log(`  run ${name}: ${e.message.slice(0, 120)}`);
  }
}
console.log(`execute: ${ran}/${sample.length} sample programs run to exit 0`);

// the gate is cproc's own suite (Part A — byte-exact IR/refusals).
// The export metrics (Parts B/C) are tracked, not gated: the shell's
// qbe2wasm backend is the partial part, not cproc.
process.exit(fail ? 1 : 0);
