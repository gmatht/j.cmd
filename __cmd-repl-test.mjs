// Headless test of the cmd REPL branch in www/index.html's runReplLine.
// Extracts the runReplLine function, stubs the perl/python paths, and
// drives the cmd mode with session replay + markers.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { runBat } from "./src/bat2js.js";

const html = readFileSync("src/shellcore/repl.js", "utf8");
const i = html.indexOf("export async function runReplLine(line, ctx) {");
if (i < 0) { console.error("FAIL: could not find runReplLine in shellcore/repl.js"); process.exit(1); }
const j = html.lastIndexOf("}");  // the file's final closing brace
let fnSrc = "(async (line, ctx) => {\n" + html.slice(html.indexOf("{", i) + 1, j) + "})";
// the dynamic import resolves relative to THIS test file, not shellcore/
fnSrc = fnSrc.replace('import("../bat2js.js")', 'import("./src/bat2js.js")');

const stdout = { _buf: "", write(s) { this._buf += s; } };
const stderr = { _buf: "", write(s) { this._buf += s; } };
const runNestedCommand = async () => ({ out: "", err: "", code: 0 });
const replState = {
  active: true, mode: "cmd", history: [], histIdx: 0,
  cmdSession: [], cmdOut: "", cmdMarker: "__cmd_repl_999__",
  bashSession: [], bashOut: "", bashMarker: "",
  perl: null, perlReady: null, perlSession: [], perlOut: "", perlMarker: "",
};
const updatePrompt = () => {};
const recordReplPrompt = () => {};
const exitRepl = () => { replState.active = false; replState.mode = null; };

globalThis.stdout = stdout; globalThis.stderr = stderr;
globalThis.replState = replState;
globalThis.fs = fs;
globalThis.runNestedCommand = runNestedCommand;
globalThis.updatePrompt = updatePrompt;
globalThis.recordReplPrompt = recordReplPrompt;
globalThis.exitRepl = exitRepl;
globalThis.runBat = runBat;
// the shared runReplLine ctx: { ctx: { replState, … }, stdout, stderr, exitRepl }
const shellCtx = { ctx: { replState }, replState, stdout, stderr, exitRepl, fs, runNestedCommand };

const runReplLine = eval(fnSrc);
let failures = 0;
const check = (label, got, want) => {
  const ok = String(got).trim() === String(want).trim();
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got:  ${JSON.stringify(String(got).trim())}\n      want: ${JSON.stringify(String(want).trim())}`}`);
};

// line 1: set a var (no output) — joins the session
stdout._buf = "";
await runReplLine("set X=hello", shellCtx);
check("set X=hello silent", stdout._buf, "");
check("session grew", replState.cmdSession.length, 1);

// line 2: set /a + read back %X% — session replay across lines
stdout._buf = "";
await runReplLine("set /a N=4+5", shellCtx);
check("set /a silent", stdout._buf, "");

stdout._buf = "";
await runReplLine("echo %X% %N%", shellCtx);
check("state persists across lines", stdout._buf, "hello 9\n");
check("session grew again", replState.cmdSession.length, 3);

// line 4: %errorlevel% reads the runtime's lastExit
stdout._buf = "";
await runReplLine("echo errorlevel=%errorlevel%", shellCtx);
check("%errorlevel% maps to $?", stdout._buf, "errorlevel=0\n");

// a refused line errors and leaves the session unchanged
stdout._buf = ""; stderr._buf = "";
const before = replState.cmdSession.length;
await runReplLine("pause", shellCtx);
check("refused line reports error", /unsupported batch command "pause"/.test(stderr._buf), true);
check("refused line keeps session", replState.cmdSession.length, before);

// exit leaves the REPL
stdout._buf = ""; stderr._buf = "";
await runReplLine("exit /b 5", shellCtx);
check("exit /b leaves REPL", replState.active, false);

console.log(failures === 0 ? "\n✓ cmd.exe browser REPL: all tests pass" : `\n✗ ${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
