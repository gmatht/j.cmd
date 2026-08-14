// ─── __rb-shim-test.mjs — runBash must hand the generated JS a
// `process` shim (echo/error output + `exit N`), like runShellScript
// does. The browser has NO node process — without the shim, a .sh
// command like mimecroft.sh crashes with "process is not defined".
// The shim is used in Node too, so .sh output routes through the
// passed stdout (capture/redirect/pipe machinery) and `exit 3` is a
// returned code, not a host kill.
import { fs } from "./src/fs/index.js";
import { runBash } from "./src/bash2js.js";

const SCRIPT = `
echo "hello from the script"
echo "HOME=$HOME"
x=41
echo "x=$x"
if [ "$x" -eq 41 ]; then echo "math works"; fi
exit 3
`;

async function run(tag) {
  const out = [];
  const err = [];
  const stdout = { write: (s) => out.push(String(s)) };
  const stderr = { write: (s) => err.push(String(s)) };
  const code = await runBash(fs, SCRIPT, { stdout, stderr, args: ["a", "b"], argv0: "t.sh", env: { HOME: "/home", USER: "t" } });
  console.log(`[${tag}] code=${code} stdout=${JSON.stringify(out.join(""))}`);
  return { code, text: out.join("") };
}

// 1) normal Node environment
const a = await run("node");

// 2) simulated browser: global process is an env-less, stdout-less stub
const saved = globalThis.process;
globalThis.process = { versions: { node: undefined }, env: undefined, argv: [] };
const b = await run("browser-no-process");
globalThis.process = saved;

const ok =
  a.code === 3 && a.text.includes("hello from the script") && a.text.includes("HOME=/home") && a.text.includes("math works") &&
  b.code === 3 && b.text.includes("hello from the script") && b.text.includes("HOME=/home") && b.text.includes("math works");
console.log("runBash process-shim test:", ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
