// Headless test of the `which` builtin added to www/index.html.
// Extracts the actual builtin source and drives it like the shell would.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";

const html = readFileSync("src/shellcore/builtins.js", "utf8");
const m = html.match(/async which\(ctx, args\) \{[\s\S]*?\n  \},\n\n  async whoami/);
if (!m) { console.error("FAIL: could not extract which builtin from shellcore"); process.exit(1); }
const src = "(" + m[0].replace(/^async which\(ctx, args\)/, "async (ctx, args) =>").replace(/\n  \},\n\n  async whoami$/, "\n}") + ")";

const stdout = { _buf: "", write(s) { this._buf += s; } };
const stderr = { _buf: "", write(s) { this._buf += s; } };
const env = { PATH: "/bin:/usr/bin" };
// stub resolveCommand: builtin | wasm | jsfile | sh | badpath | null
const resolveCommand = async (name) => {
  if (name === "ls") return { type: "builtin", fn: () => {} };
  if (name === "grep") return { type: "wasm", path: "/bin/grep.wasm" };
  if (name === "edit") return { type: "jsfile", path: "/bin/edit.js" };
  if (name === "hello") return { type: "sh", path: "/home/hello.sh" };
  if (name === "dir") return { type: "badpath", path: "/tmp/dir", err: "Is a directory" };
  if (name === "cmd") return null;
  return null;
};
globalThis.stdout = stdout; globalThis.stderr = stderr;
globalThis.env = env;
globalThis.resolveCommand = resolveCommand;
const shellCtx = { stdout, stderr, env, findCommand: resolveCommand };
const which = eval(src);
let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`}`);
};

stdout._buf = ""; stderr._buf = "";
let code = await which(shellCtx, ["ls"]);
check("builtin", stdout._buf, "ls: shell builtin\n");
check("builtin exit", code, 0);

stdout._buf = ""; stderr._buf = "";
code = await which(shellCtx, ["grep"]);
check("wasm path", stdout._buf, "/bin/grep.wasm\n");

stdout._buf = ""; stderr._buf = "";
code = await which(shellCtx, ["edit", "hello"]);
check("jsfile + sh", stdout._buf, "/bin/edit.js\n/home/hello.sh\n");

stdout._buf = ""; stderr._buf = "";
code = await which(shellCtx, ["dir"]);
check("badpath annotated", stdout._buf, "/tmp/dir (not executable: Is a directory)\n");

stdout._buf = ""; stderr._buf = "";
code = await which(shellCtx, ["cmd"]);
check("missing stderr", stderr._buf, "which: no cmd in (/bin:/usr/bin)\n");
check("missing exit", code, 1);

stdout._buf = ""; stderr._buf = "";
code = await which(shellCtx, []);
check("no args", stderr._buf, "which: missing operand\n");
check("no args exit", code, 2);

console.log(failures === 0 ? "\n✓ which browser builtin: all tests pass" : `\n✗ ${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
