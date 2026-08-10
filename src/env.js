// ─── Environment Variables ─────────────────────────────────────
//
// The shell's environment — $PATH, $HOME, $USER and friends.
// One shared singleton so the CLI (src/jtsh.js), the browser
// shell (www/index.html) and the WASI runtime (src/wasm.js) all
// see the same values.
//
// Defaults follow the virtual filesystem's layout:
//   PATH  — command search path (colon-separated, POSIX order;
//           resolveCommand walks it left to right)
//   HOME  — default directory (bare `cd` goes here)
//   USER  — owner name shown by `ls -l`
//   PWD   — current directory (kept in sync by the `cd` builtin)
// -----------------------------------------------------------------

// ─── Last exit status (`$?`) ──────────────────────────────────
// The native shell tracks the exit status of the last command here so
// the tokenizer can expand `$?` (expandRef below). jtsh updates it after
// every command; the transpiler path syncs it with the sh2 runtime's
// own sh2.lastExit in both directions.
let shellStatus = 0;
export function setShellStatus(n) { shellStatus = Number(n) || 0; }
export function getShellStatus() { return shellStatus; }

// ─── $$ / $! — shell pid and last background-job pid ──────────
// `$$` is the shell itself (/proc/self — pid 1 in procfs.js); `$!` is
// the pid of the most recently launched background job, recorded by the
// shell when it starts one.
let shellPid = "1";
let lastBgPid = "";
export function setShellPid(n) { shellPid = String(n ?? "1"); }
export function setLastBgPid(n) { lastBgPid = String(n ?? ""); }

// ─── Positional parameters ($0…$9, $#, $@, $*) ────────────────
// Set by `bash script.sh a b` (the script's args), `set -- a b`, and
// cleared between top-level lines. The transpiled path syncs these into
// the sh2 runtime's sh2.positional / argv0 before each eval.
let positional = [];
let argv0 = "jtsh";
export function setPositional(arr, a0) {
  positional = Array.isArray(arr) ? arr.map(String) : [];
  if (a0 !== undefined) argv0 = String(a0);
}
export function getPositional() { return positional; }
export function getArgv0() { return argv0; }

// ─── Shell option flags (set -e/-u/-x …) ──────────────────────
// Accepted and stored so scripts that `set -e` don't error. Interactive
// shells do nothing with -e anyway (a failure just sets $? and returns
// to the prompt); -x is honoured by the native path (it prints each
// command before running it).
const shellOptions = new Set();
export function setOption(f, on) { if (on) shellOptions.add(String(f)); else shellOptions.delete(String(f)); }
export function hasOption(f) { return shellOptions.has(String(f)); }

// ─── readonly variables ────────────────────────────────────────
// `readonly x` marks a name; setVar / export refuse to change it (the
// runtime's setVar path and the harvest both consult this set).
const readonlyNames = new Set();
export function markReadonly(name) { readonlyNames.add(name); }
export function isReadonly(name) { return readonlyNames.has(name); }
export function listReadonly() { return [...readonlyNames]; }

export const env = {
  PATH: "/bin:/usr/bin",
  HOME: "/home",
  USER: "jtsh",
  PWD: "/home",
  // the usual suspects scripts probe for — real values, not empty
  SHELL: "/bin/jtsh",
  TERM: "xterm-256color",
  HOSTNAME: "jtsh",
  LANG: "C.UTF-8",
  EDITOR: "vi",
  PAGER: "cat",
  // Terminal geometry (columns × rows). The browser shell keeps these
  // in sync with the window size; a conventional 80×24 default matches
  // what scripts assume before the first resize.
  COLUMNS: "80",
  LINES: "24",
};

// Expand the environment reference starting at str[i] ('$').
// Supports $NAME and ${NAME}. An unknown variable expands to ""
// (POSIX behaviour). A '$' not followed by a valid name (or '{')
// is left as a literal '$'.
// Returns { value, end } where `end` is the index just past the
// reference (i + 1 for a literal '$').
export function expandRef(str, i) {
  if (str[i] !== "$") return null;
  if (str[i + 1] === "?") return { value: String(getShellStatus()), end: i + 2 };  // $?
  if (str[i + 1] === "$") return { value: shellPid, end: i + 2 };  // $$
  if (str[i + 1] === "!") return { value: lastBgPid, end: i + 2 };  // $!
  if (str[i + 1] === "#") return { value: String(positional.length), end: i + 2 };  // $#
  if (str[i + 1] === "@" || str[i + 1] === "*") {  // $@ / $*
    return { value: positional.join(" "), end: i + 2 };
  }
  if (str[i + 1] === "0") return { value: argv0, end: i + 2 };  // $0
  if (/^[1-9]/.test(str.slice(i + 1))) {  // $1..$9
    const n = Number(str[i + 1]);
    return { value: n <= positional.length ? positional[n - 1] : "", end: i + 2 };
  }
  if (str[i + 1] === "{") {
    const close = str.indexOf("}", i + 2);
    if (close === -1) return { value: "$", end: i + 1 }; // unterminated → literal
    const name = str.slice(i + 2, close);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { value: name in env ? String(env[name]) : "", end: close + 1 };
    }
    if (/^[0-9]+$/.test(name)) {  // ${1}..${N} — positional parameters
      const n = Number(name);
      return { value: n >= 1 && n <= positional.length ? positional[n - 1] : "", end: close + 1 };
    }
    // Invalid name (e.g. ${1x}) — keep the whole thing literal
    return { value: str.slice(i, close + 1), end: close + 1 };
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(str.slice(i + 1));
  if (m) {
    return { value: m[0] in env ? String(env[m[0]]) : "", end: i + 1 + m[0].length };
  }
  return { value: "$", end: i + 1 };
}
