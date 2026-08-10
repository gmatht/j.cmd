// ─── __shell-regression.mjs — regression tests for bugs that broke the
// browser shell (and the shared src/shellcore pipeline) ──────────────
// Each case drives the REAL shell (node src/jtsh.js — the CLI exercises
// the same shared runner/estree/builtins the browser uses) and asserts
// on the output. Run in CI / the deploy gate; any FAIL must be fixed
// before shipping.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (lines, opts = {}) => {
  try {
    return execFileSync("node", ["src/jtsh.js"], {
      cwd: process.cwd(),
      input: lines.join("\n") + "\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: opts.timeout || 120000,
      env: process.env,
    });
  } catch (e) {
    return (e.stdout || "") + "\n" + (e.stderr || "");
  }
};

let fails = 0;
const check = (name, cond, out) => {
  if (cond) { console.log("PASS: " + name); }
  else { fails++; console.log("FAIL: " + name + "\n  got: " + JSON.stringify(String(out)).slice(0, 300)); }
};

// 1. the five-file source loop via `.` — regression: builtins aliases
//    snapshotted a removed local source → ".: command not found"
const loop = run([
  "for f in /home/examples/source.{bat,c,fish,sh,zsh}; do . $f; done",
]);
check("five-file '.' loop sources all", /Hello from batch-land score=5/.test(loop) && /source\.c — C constants/.test(loop), loop);

// 2. sourced C functions are callable (the InterruptError import /
//    source-builtin path)
const fn = run([
  "source /home/examples/source.c >/dev/null",
  "a=(10 20 30)",
  'sum_first a 3; echo "sum=$?"',
]);
check("sum_first C return in $?", /sum=60/.test(fn), fn);

// 3. MISSING WRITES: a C function's store writes must be visible to a
//    SAME-LINE echo (regression: `$a` compiled against the seed's native
//    `let a = [...]` instead of the store → stale "10 20 30")
// fill OVERWRITES elements 0..N-1, so the seed must not matter — start
// from zeros to prove the 0/10/20 come from fill itself (independent).
const w1 = run([
  "source /home/examples/source.c >/dev/null",
  "a=(0 0 0)",
  'fill a 3; echo "a=(${a[@]})"',
]);
check("fill one-liner write visible (seed-independent)", /a=\(0 10 20\)/.test(w1), w1);

const w2 = run([
  "source /home/examples/source.c >/dev/null",
  "b=(10 30 20)",
  'sort_ints b 3; echo "b=(${b[@]})"',
]);
check("sort_ints one-liner write visible", /b=\(10 20 30\)/.test(w2), w2);

// 4. the shellExec bridge — regression: the shared ensureOtRuntime built
//    the persistent runtime with shellExec: undefined, so a transpiled
//    command needing the shell bridge ('.' inside a loop) fell back to
//    "for: command not found"
const br = run([
  "for f in /home/examples/source.bat /home/examples/source.sh; do . $f; done",
]);
check("transpiled '.' shell bridge works", /Hello from batch-land score=5/.test(br), br);

// 5. glob works in the CLI too (the browser-only glob is now shared)
const g = run([
  "mkdir -p /tmp/greg",
  'printf "x" > /tmp/greg/a.txt',
  'printf "y" > /tmp/greg/b.log',
  "ls /tmp/greg/*.txt",
]);
check("glob expansion (CLI)", /a\.txt/.test(g) && !/\*\.txt/.test(g), g);

// 6. brace expansion + ls <file> (regressions: braces went through the
//    transpiler's sync-builtin stub, and ExamplesFS had no stat so
//    `ls <file>` on /examples printed nothing)
const br2 = run([
  "echo {a,b,c}",
  "ls /examples/c/{linked_list,my_qsort}.c",
  "ls /examples/c/my_qsort.c",
]);
check("brace expansion", /a b c/.test(br2), br2);
check("brace-expanded ls lists both files", /linked_list\.c/.test(br2) && /my_qsort\.c/.test(br2), br2);
check("ls <file> on /examples prints the name", /^my_qsort\.c/m.test(br2), br2);

// 7. the browser app module must PARSE — no duplicate declarations, no
//    dangling ctx shorthands, no stray brace/comma artifacts (all three
//    have broken the page at runtime)
const html = readFileSync("www/index.html", "utf8");
const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = blocks.sort((a, b) => b.length - a.length)[0] || "";
const decls = [...big.matchAll(/^(?:export )?(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
const counts = decls.reduce((a, n) => (a[n] = (a[n] || 0) + 1, a), {});
const dup = Object.entries(counts).filter(([, n]) => n > 1);
check("browser module: no duplicate declarations", dup.length === 0, dup);

const ci = big.indexOf("const shellCtx = {");
let badShorthand = null;
if (ci >= 0) {
  const seg = big.slice(ci, ci + 6000);
  for (const s of seg.matchAll(/^\s{2}([A-Za-z_$][\w$]*),$/gm)) {
    const name = s[1];
    if (!new RegExp("^(?:const|let|var|function|async function|class)\\s+" + name + "\\b", "m").test(big) &&
        !new RegExp("^import [^;]*\\b" + name + "\\b[^;]*;", "m").test(big)) { badShorthand = name; break; }
  }
}
check("browser ctx: no dangling shorthand keys", badShorthand === null, badShorthand);
check("browser module: no stray brace/comma artifacts", !/,,\s|\}\s*\}\s*,\s*\{/.test(big), "stray artifact");

console.log(fails === 0 ? "\nALL SHELL REGRESSION TESTS PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
