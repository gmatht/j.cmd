// ─── shellcore/tokenize.js — the SHARED command-line tokenizer ──
// The browser shell's version (the richer one): it attaches
// `tokens._quoted` (a parallel array marking quoted words, so globs in
// quoted positions stay literal). The CLI ignores the property — both
// shells share one implementation.
import { env, expandRef } from "../env.js";

export function tokenize(segment) {
  const tokens = [];
  const quotedFlags = [];   // parallel: was this token quoted? (globs stay literal)
  let cur = "";
  let started = false;  // have we begun a word?
  let quoted = false;   // did this word contain an explicit quote? (so '' → "")
  let inSingle = false;
  let inDouble = false;

  const push = () => {
    if (started || quoted) { tokens.push(cur); quotedFlags.push(quoted); }
    cur = "";
    started = false;
    quoted = false;
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "\\" && ['"', "\\", "$", "`"].includes(segment[i + 1])) {
        cur += segment[++i]; // escaped char loses its special meaning
      } else if (ch === "$") {
        // $NAME / ${NAME} expansion (valid inside double quotes too)
        const ref = expandRef(segment, i);
        cur += ref.value;
        i = ref.end - 1;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'") { inSingle = true; started = true; quoted = true; continue; }
    if (ch === '"') { inDouble = true; started = true; quoted = true; continue; }
    if (ch === "\\") {
      if (i + 1 < segment.length) cur += segment[++i];
      started = true;
      continue;
    }
    if (ch === "~" && !started && !quoted) {
      // ~ / ~/path → $HOME / $HOME/path (tilde expansion)
      cur += env.HOME;
      started = true;
      continue;
    }
    if (ch === "$") {
      // $NAME / ${NAME} expansion outside quotes. The RESULT is
      // field-split on IFS (bash semantics): `x="a b"; echo $x` passes
      // two words. Quoted expansions (in the inDouble branch) never
      // split; a mid-word expansion (`pre$x`) appends unsplit.
      const ref = expandRef(segment, i);
      i = ref.end - 1;
      if (started) {
        cur += ref.value;
      } else {
        const ifs = env.IFS !== undefined ? String(env.IFS) : " \t\n";
        const val = String(ref.value);
        if (ifs === "" || val === "") {
          cur += val;
          started = true;
        } else {
          const cls = ifs.replace(/[\]\\^$.*+?{}()|[\]-]/g, "\\$&");
          const pieces = val.split(new RegExp("[" + cls + "]+")).filter((p) => p !== "");
          if (pieces.length === 0) continue;   // empty/unset var → no field (bash)
          for (let k = 0; k < pieces.length - 1; k++) tokens.push(pieces[k]);
          cur = pieces[pieces.length - 1];
          started = true;
        }
      }
      continue;
    }
    if (ch === ">") {
      // `>` is a metacharacter (bash-style): `echo 1>log` redirects to
      // log instead of echoing "1>log". Split it out of the word — but
      // the fd forms stay GLUED as one redirect token: `2>file`,
      // `2>>file`, `2>&1`, `>&2`, `&>file` (a glued digit prefix before
      // `>` is the fd, not an argument — exactly what bash does).
      let tok = ">";
      const fdPrefix = /^\d+$/.test(cur) ? cur : null;
      if (fdPrefix) { cur = ""; started = false; tok = fdPrefix + ">"; }
      else if (cur === "&") { cur = ""; started = false; tok = "&>"; }   // &>file — both streams
      else push();
      if (segment[i + 1] === ">") { tok += ">"; i++; }
      // `>&fd` fd-dup — absorb the `&` and its digits: `>&2`, `2>&1`
      if (segment[i + 1] === "&") {
        let j = i + 2;
        while (j < segment.length && /\d/.test(segment[j])) j++;
        if (j > i + 2) { tok += "&" + segment.slice(i + 2, j); i = j - 1; }
        else { tok += "&"; i++; }
      }
      tokens.push(tok); quotedFlags.push(false);
      continue;
    }
    if (/\s/.test(ch)) { push(); continue; }
    cur += ch;
    started = true;
  }
  if (inSingle) throw new Error(`unexpected EOF while looking for matching "'"`);
  if (inDouble) throw new Error(`unexpected EOF while looking for matching '"'`);
  push();
  tokens._quoted = quotedFlags;   // callers use this for glob expansion
  return tokens;
}
