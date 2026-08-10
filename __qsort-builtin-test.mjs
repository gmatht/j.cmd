// Headless test of the `qsort` builtin added to www/index.html.
// Extracts the actual builtin source from index.html and evals it
// against a real createSh2Runtime, then drives it like the shell would.
import { readFileSync } from "fs";
import { createSh2Runtime } from "./src/sh2runtime.js";

const html = readFileSync("src/shellcore/builtins.js", "utf8");
// Grab the qsort builtin body from the SHARED shell core:
const m = html.match(/async qsort\(ctx, args\) \{[\s\S]*?\n  \},\n\n  async readonly/);
if (!m) { console.error("FAIL: could not extract qsort builtin from shellcore"); process.exit(1); }
const src = "(" + m[0].replace(/^async qsort\(ctx, args\)/, "async (ctx, args) =>").replace(/\n  \},\n\n  async readonly$/, "\n}") + ")";

const stdout = { _buf: "", write(s) { this._buf += s; } };
const stderr = { _buf: "", write(s) { this._buf += s; } };
const otVars = new Map();   // persistent-state mirror (like jtsh's)
const env = {};             // native-line env mirror
let otRt = null;
// echo → { out } so sh2.exec (mode-aware) routes it into capture buffers
const shellExec = async (cmdline) => {
  const cl = cmdline.trim();
  if (cl.startsWith("echo ")) return { out: cl.slice(5) + "\n", err: "", code: 0 };
  return { out: "", err: "", code: 0 };
};
const ensureOtRuntime = async () => { if (!otRt) otRt = createSh2Runtime({ fs: null, env: {}, shellExec, stdout, stderr, argv0: "bash" }); };
globalThis.stdout = stdout; globalThis.stderr = stderr;
globalThis.otVars = otVars; globalThis.env = env;
globalThis.ensureOtRuntime = ensureOtRuntime;
globalThis.otRt = null;
const shellCtx = { otRt: () => otRt, ensureOtRuntime, stdout, stderr, nodeEnv: undefined };
Object.defineProperty(shellCtx, "otRt", { get: () => otRt });
const qsort = eval(src);

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log("  ok  " + label); } else { fail++; console.log("  FAIL " + label); } };

// --- register a real bash-style compar function on the runtime ---
await ensureOtRuntime();
const sh2 = otRt.sh2;
const mkCompar = (signFn) => sh2.define("alphabetic_compare", async function () {
  const [a, b] = sh2.positional;
  // like `if [[ "$1" < "$2" ]]; then echo -1; … fi` — emit via exec
  return sh2.exec("echo", [signFn(a, b)]);
});

// alphabetic compar (qsort convention: echo -1/0/1)
mkCompar((a, b) => (a < b ? "-1" : a > b ? "1" : "0"));

console.log("--- numeric compar via fnCall+positional ---");
sh2.setArray("a", ["pear", "apple", "fig", "banana"]);
let r = await qsort(shellCtx, ["a", "alphabetic_compare"]);
check("exit 0", r === 0);
check("sorted", JSON.stringify(sh2.vars["a"]) === JSON.stringify(["apple", "banana", "fig", "pear"]));

console.log("--- reverse numeric compar ---");
sh2.define("desc_compare", async function () {
  const [a, b] = sh2.positional;
  return sh2.exec("echo", [Number(a) < Number(b) ? "1" : Number(a) > Number(b) ? "-1" : "0"]);
});
sh2.setArray("n", ["10", "3", "25", "7", "3"]);
r = await qsort(shellCtx, ["n", "desc_compare"]);
check("desc sorted", JSON.stringify(sh2.vars["n"]) === JSON.stringify(["25", "10", "7", "3", "3"]));

console.log("--- errors ---");
r = await qsort(shellCtx, ["a", "no_such_fn"]);
check("no function → 1", r === 1);
check("stderr mentions function", stderr._buf.includes("no function 'no_such_fn'"));
stderr._buf = "";
r = await qsort(shellCtx, ["scalar_var", "alphabetic_compare"]);
check("not an array → 1", r === 1);
stderr._buf = "";
r = await qsort(shellCtx, []);
check("empty args → help 0", r === 0);
r = await qsort(shellCtx, ["a"]);
check("missing compar → 2", r === 2);
r = await qsort(shellCtx, ["-h"]);
check("help → 0", r === 0);

console.log("--- help mentions the protocol ---");
check("help shows COMPARFN", stdout._buf.includes("COMPARFN"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
