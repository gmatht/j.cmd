// ─── wasm-tcc tests2 suite runner ───────────────────────────────
//
// Runs the TinyCC upstream tests2 suite against the wasm tcc fork
// (www/wasm-bin/tcc.wasm) in LINK mode, mirroring the upstream
// tests/tests2/Makefile as closely as the wasm backend allows:
//
//   tcc [FLAGS] file.c [companions...] -o file.wasm
//   ./file.wasm [ARGS]
//
// Output (stdout+stderr) is diffed against file.expect with the
// upstream FILTER applied (source dir stripped — we compile from the
// sandbox cwd with bare filenames so paths already match).
//
// Usage: node __tcc-suite-test.mjs [filter]
//   filter   optional substring — only run tests whose name contains it
//
// Exit codes per test are classified:
//   PASS   output matches .expect
//   CCERR  tcc failed to compile (exit != 0, no module) — output != expect
//   DIFF   compiled+ran, output differs from .expect
//   RUNERR running the module crashed (wasm trap)
// -----------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from "fs";
import { fs } from "./src/fs/index.js";
import { WasmRunner } from "./src/wasm.js";

const SRC = "build/tcc-wasm/tests/tests2";
const WORK = "/home/tcc-suite";
const filter = process.argv[2] || "";

// ─── setup: seed tcc.wasm, headers, test sources ─────────────────
await fs.writeBlob("/usr/bin/tcc.wasm",
  new Blob([readFileSync("www/wasm-bin/tcc.wasm")]));
const runner = new WasmRunner(fs);
await runner._ensureInit();
const { ensureTccHeaders } = await import("./src/tcc.js");
const fetchBundle = async (rel) => new Uint8Array(readFileSync("www/" + rel));
await ensureTccHeaders(fs, fetchBundle);

for (const f of readdirSync(SRC)) {
  if (f.endsWith(".c") || f.endsWith(".h"))
    await fs.write(WORK + "/" + f, readFileSync(SRC + "/" + f, "utf8"));
}
fs.cwd = WORK;
runner.vfs = fs;

// ─── upstream skip list for a wasm32 (non-x86/arm/riscv) target ──
// (mirrors tests/tests2/Makefile; bcheck/backtrace/dll/tls groups
//  depend on the build config — flagged separately below)
const SKIP = new Set([
  "34_array_assignment",        // always: not in the C standard
  "85_asm-outside-function",    // x86 asm
  "98_al_ax_extend",            // i386
  "99_fastcall",                // i386
  "127_asm_goto",               // x86 asm
  "138_arm64_encoding",         // arm64
  "139_arm64_errors",           // arm64
  "140_arm64_extasm",           // arm64
  "141_riscv_asm",              // riscv64
  "145_winarm64_interlocked",   // arm64+win32
]);

// Per-test FLAGS/ARGS from the upstream Makefile.
const FLAGS = {
  "76_dollars_in_identifiers": ["-fdollars-in-identifiers"],
  "22_floating_point": ["-lm"],
  "24_math_library": ["-lm"],
};
const ARGS = {
  "31_args": ["arg1", "arg2", "arg3", "arg4", "arg5"],
  "46_grep": ["[^* ]*[:a:d: ]+\\:*-/: $", "46_grep.c"],
};
// Companion sources (multi-file tests).
const COMPANIONS = {
  "104_inline": ["104+_inline.c"],
  "120_alias": ["120+_alias.c"],
};

// ─── helpers ─────────────────────────────────────────────────────
const combined = (r) => r.getStdout() + r.getStderr();

async function tcc(args) {
  try {
    await runner.run("/usr/bin/tcc.wasm", ["tcc", ...args]);
    return { exit: runner.getExitCode(), out: combined(runner) };
  } catch (e) {
    return { exit: -1, out: combined(runner) + "\n[trap] " + e.message };
  }
}

async function runWasm(name, args) {
  const path = WORK + "/" + name + ".wasm";
  try {
    await runner.run(path, ["./" + name + ".wasm", ...(args || [])]);
    return { exit: runner.getExitCode(), out: combined(runner) };
  } catch (e) {
    return { exit: -99, out: combined(runner) + "\n[trap] " + e.message };
  }
}

const norm = (s) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "\n");

// ─── run one test ────────────────────────────────────────────────
async function runTest(name) {
  const cFile = `${SRC}/${name}.c`;
  if (!existsSync(cFile)) return null;
  const expect = norm(readFileSync(`${SRC}/${name}.expect`, "utf8"));
  const flags = FLAGS[name] || [];
  const args = ARGS[name] || [];
  const companions = (COMPANIONS[name] || []).map((f) => `${SRC}/${f}`);
  for (const f of companions) {
    if (existsSync(f)) await fs.write(WORK + "/" + f.split("/").pop(),
      readFileSync(f, "utf8"));
  }

  const srcs = [name + ".c", ...(COMPANIONS[name] || [])];

  // compile (LINK mode)
  const outWasm = WORK + "/" + name + ".wasm";
  try { await fs.unlink(outWasm); } catch {}
  const c = await tcc([...flags, ...srcs, "-o", name + ".wasm"]);
  let haveWasm = true;
  try { const st = await fs.stat(outWasm); haveWasm = st.size > 0; } catch { haveWasm = false; }

  if (!haveWasm || c.exit !== 0) {
    // compile failed — compare the compiler's output to .expect
    return { name, status: "CCERR", output: c.out, expect, exit: c.exit };
  }

  const r = await runWasm(name, args);
  return { name, status: "RUN", output: r.out, expect, exit: r.exit };
}

// ─── main loop ───────────────────────────────────────────────────
const tests = readdirSync(SRC)
  .filter((f) => /^\d+_[\w-]+\.c$/.test(f) && f !== "95_bitfields_ms.c")  // ms-compiler variant
  .map((f) => f.replace(/\.c$/, ""))
  .filter((n) => !SKIP.has(n) && n.includes(filter))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const results = { PASS: [], CCERR: [], DIFF: [], RUNERR: [], SKIPPED: [] };
for (const name of tests) {
  const r = await runTest(name);
  if (!r) continue;
  const match = r.output.replace(/\r\n/g, "\n").replace(/\s+$/, "\n") === r.expect;
  if (r.status === "CCERR") results.CCERR.push(r);
  else if (r.status === "RUN" && match) results.PASS.push(r);
  else if (r.status === "RUN" && r.exit === -99) results.RUNERR.push(r);
  else results.DIFF.push(r);
  const mark = r.status === "CCERR" ? "CCERR" : match ? "PASS " : (r.exit === -99 ? "RUNERR" : "DIFF ");
  console.log(`${mark} ${name}${match ? "" : "  <- expected " + r.expect.length + " got " + r.output.length + " chars"}`);
}

console.log(`\n=== summary ===`);
console.log(`PASS ${results.PASS.length}  CCERR ${results.CCERR.length}  DIFF ${results.DIFF.length}  RUNERR ${results.RUNERR.length}  (of ${tests.length})`);
if (filter || results.CCERR.length + results.DIFF.length + results.RUNERR.length <= 8) {
  console.log("\n--- failures ---");
  for (const r of [...results.CCERR, ...results.DIFF, ...results.RUNERR]) {
    console.log(`\n### ${r.name} [${r.status}] exit=${r.exit}`);
    console.log("--- output (first 40 lines) ---");
    console.log(r.output.split("\n").slice(0, 40).join("\n"));
    console.log("--- expect (first 40 lines) ---");
    console.log(r.expect.split("\n").slice(0, 40).join("\n"));
  }
}
