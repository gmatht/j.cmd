// ─── Environment Variables ─────────────────────────────────────
//
// The shell's environment — $PATH, $HOME, $USER and friends.
// One shared singleton so the CLI (src/tinysh.js), the browser
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

export const env = {
  PATH: "/commands:/usr/bin:/bin",
  HOME: "/home",
  USER: "tinysh",
  PWD: "/home",
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
  if (str[i + 1] === "{") {
    const close = str.indexOf("}", i + 2);
    if (close === -1) return { value: "$", end: i + 1 }; // unterminated → literal
    const name = str.slice(i + 2, close);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { value: name in env ? String(env[name]) : "", end: close + 1 };
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
