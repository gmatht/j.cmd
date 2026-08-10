// ─── shellcore/glob.js — glob expansion (ls *.png → matched paths) ──
// SHARED by both shells — the CLI previously had no glob support; the
// tokenizer already attaches the _quoted flags, so expansion works
// identically on both. fs comes from the shared VFS import.
import { fs } from "../fs/index.js";

export function globToRegex(pat) {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") re += "[^/]*";            // * never crosses a /
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = pat.indexOf("]", i + 1);
      if (end === -1) { re += "\\["; }
      else {
        let cls = pat.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);  // [!a-z] = negation
        cls = cls.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
        re += "[" + cls + "]";
        i = end;
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

export async function globExpand(pattern) {
  const abs = pattern.startsWith("/");
  const parts = pattern.replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length === 0) return [];
  const results = [];
  const walk = async (dirPath, i) => {
    const comp = parts[i];
    const last = i === parts.length - 1;
    const hasGlob = /[*?[]/.test(comp);
    // "." and ".." are navigation, not names to match
    if (comp === ".") return walk(dirPath, i + 1);
    if (comp === "..") {
      const up = dirPath.replace(/\/+$/, "").replace(/\/[^\/]*$/, "") || "/";
      return walk(up, i + 1);
    }
    let entries;
    try { entries = await fs.list(dirPath); } catch { return; }
    const re = hasGlob ? globToRegex(comp) : null;
    for (const e of entries) {
      const name = e.replace(/\/+$/, "");
      // Like bash: a leading dot must be matched explicitly
      if (hasGlob && name.startsWith(".") && !comp.startsWith(".")) continue;
      const match = hasGlob ? re.test(name) : name === comp;
      if (!match) continue;
      const nextPath = dirPath === "/" ? "/" + name : dirPath + "/" + name;
      if (last) {
        results.push(nextPath);
      } else {
        // Descend into directories AND mounted zips (a .zip file that
        // resolves to a mount — fs.list triggers the lazy zip mount).
        try {
          await fs.list(nextPath);
          await walk(nextPath, i + 1);
        } catch { /* plain file — not a directory */ }
      }
    }
  };
  if (abs) await walk("/", 0);
  else await walk(fs.cwd === "/" ? "/" : fs.cwd, 0);
  return results.sort();
}

// Expand every unquoted glob token in a token list (tokenize attaches
// the parallel `_quoted` flags). Comma-brace expansion ({a,b}.c → a.c
// b.c) runs first, then the glob pass.
export async function globExpandTokens(tokens) {
  const quotedFlags = tokens._quoted || [];
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const expanded = quotedFlags[i] ? [t] : braceExpandToken(t);
    for (const e of expanded) {
      if (!quotedFlags[i] && /[*?[]/.test(e)) {
        const matches = await globExpand(e);
        out.push(...(matches.length > 0 ? matches : [e]));
      } else {
        out.push(e);
      }
    }
  }
  return out;
}

// bash brace expansion `pre{a,b,c}post` → `preapost prebpost precpost`
// (comma form; ${...} and { cmd; } blocks are untouched).
export function braceExpandToken(token) {
  const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(token);
  if (!m) return [token];
  const [, pre, list, post] = m;
  const out = [];
  for (const item of list.split(",")) {
    for (const e of braceExpandToken(pre + item + post)) out.push(e);
  }
  return out;
}

