// Headless test of the `cmd.exe` builtin added to www/index.html.
// Extracts the actual builtin source from index.html and evals it
// against the real bat2js pipeline (src/bat2js.js), then drives it
// like the browser shell would.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { batToJS, runBat } from "./src/bat2js.js";

const html = readFileSync("src/shellcore/builtins.js", "utf8");
const i = html.indexOf("async cmdExe(ctx, args) {");
if (i < 0) { console.error("FAIL: could not find cmdExe in shellcore"); process.exit(1); }
const j = html.lastIndexOf("\n  }\n};");
const src = "(async (ctx, args) => {\n" + html.slice(html.indexOf("{", i) + 1, j) + "\n})";

const stdout = { _buf: "", write(s) { this._buf += s; } };
const stderr = { _buf: "", write(s) { this._buf += s; } };
let replEntered = false;
class InterruptError extends Error {}
const runNestedCommand = async (cmdLine) => {
  const cl = cmdLine.trim();
  if (cl.startsWith("echo ")) return { out: cl.slice(5) + "\n", err: "", code: 0 };
  if (cl === "type" || cl === "cat") return { out: "", err: "", code: 0 };
  return { out: "", err: "", code: 0 };
};
const enterRepl = (mode) => { replEntered = true; };
const shellCtx = { stdout, stderr, stdin: "", isTTY: false, runNestedCommand, enterRepl };
const ttyCtx = { ...shellCtx, isTTY: true };
globalThis.stdout = stdout; globalThis.stderr = stderr;

globalThis.fs = fs;
globalThis.runNestedCommand = runNestedCommand;
globalThis.enterRepl = enterRepl;
globalThis.InterruptError = InterruptError;
globalThis.batToJS = batToJS;
globalThis.runBat = runBat;

const cmdExe = eval(src);
let failures = 0;
const check = (label, got, want) => {
  const ok = String(got).trim() === String(want).trim();
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got:  ${JSON.stringify(String(got).trim())}\n      want: ${JSON.stringify(String(want).trim())}`}`);
};

// inline source
stdout._buf = ""; stderr._buf = "";
let code = await cmdExe(shellCtx, ["echo hello world"]);
check("inline source", stdout._buf, "hello world\n");
check("inline exit code", code, 0);

// /c with & separator
stdout._buf = ""; stderr._buf = "";
code = await cmdExe(shellCtx, ["/c", "set /a N=2+3 & echo %N%"]);
check("/c run+exit", stdout._buf, "5\n");

// --js (bat2js mode)
stdout._buf = ""; stderr._buf = "";
code = await cmdExe(shellCtx, ["--js", "echo hi"]);
check("--js emits generated JS", /process\.stdout\.write\("hi\\n"\)/.test(stdout._buf), true);

// file + positional args
await fs.write("/home/t.bat", "@echo off\necho args: %1 %2\n");
stdout._buf = ""; stderr._buf = "";
code = await cmdExe(shellCtx, ["t.bat", "3", "4"]);
check("file + args", stdout._buf, "args: 3 4\n");

// pipe
shellCtx.stdin = "echo piped\n";
stdout._buf = ""; stderr._buf = "";
code = await cmdExe(shellCtx, []);
check("pipe input", stdout._buf, "piped\n");


// bare → REPL
stdout._buf = ""; stderr._buf = "";
replEntered = false;
code = await cmdExe(ttyCtx, []);
check("bare cmd.exe enters REPL", replEntered, true);

// refused syntax errors loudly
stdout._buf = ""; stderr._buf = "";
code = await cmdExe(shellCtx, ["pause"]);
check("refused command reports error", /unsupported batch command "pause"/.test(stderr._buf), true);

console.log(failures === 0 ? "\n✓ cmd.exe browser builtin: all tests pass" : `\n✗ ${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
