// ─── binsync: lazy materialization of /bin command files ────────
//
// The shell's commands are plain .js files in /bin (LocalStorageFS in
// the browser, RamFS in the CLI). Their source lives OUTSIDE the core
// bundle, as static templates in www/bin/<name>.js — fetched once and
// written into the VFS when the command is first resolved, instead of
// embedding ~184 KB of command source in the bundle and writing it all
// at boot.
//
// Version markers: every template's first line is `// <cmd> vN — ...`.
// If an older copy already exists in the VFS (an upgrade scenario), the
// new template replaces it; up-to-date copies are left untouched. The
// check happens once per command per session.
//
// Template cache-busting: the browser fetch below appends `?v=N` so a
// redeployed template (a changed www/bin/<cmd>.*) is never served from
// the HTTP cache — a stale staged copy once kept printing a terminal
// map the current game no longer emits.
// -----------------------------------------------------------------

import { fs } from "./fs/index.js";

const BIN_VERSION = "6";   // bump whenever www/bin templates change

const done = new Map();   // command name → resolved /bin path (materialized/verified this session)
const nope = new Set();   // commands confirmed NOT template-backed (don't retry)
const loading = new Map();   // command name → in-flight promise (dedupe)

function templateUrl(name) {
  // www/bin/<name> lives one level up from src/. An explicit .js/.sh
  // extension is used as-is (a .sh command template); otherwise the
  // historic .js suffix is appended.
  const file = /\.(js|sh|mjs)$/.test(name) ? name : name + ".js";
  return new URL("../www/bin/" + file, import.meta.url);
}

async function loadTemplate(name) {
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    const { readFileSync } = await import("node:fs");
    return readFileSync(templateUrl(name), "utf8");
  }
  const resp = await fetch(templateUrl(name).href + "?v=" + BIN_VERSION);
  if (!resp.ok) throw new Error("template " + name + " not found (" + resp.status + ")");
  return resp.text();
}

// Forget every materialization decision — the next command resolve
// re-fetches and re-verifies templates against /bin (the `/cache` purge
// calls this so `rm -r /cache/bin` refreshes staged commands).
export function clearBinCache() {
  done.clear();
  nope.clear();
  loading.clear();
}

// The version marker (`// <cmd> vN`) the template declares, or null.
function versionMarker(name, source) {
  const m = /\/\/\s*[\w-]+ v(\d+)/.exec(source.split("\n")[0] || "");
  return m ? m[0] : null;
}

// Ensure /bin/<name>.js (or /bin/<name>.sh) exists and is current;
// returns the resolved VFS path on success, or null when there is no
// template for `name`.
export async function materializeBinCommand(name) {
  const clean = String(name).replace(/\.js$/, "");
  if (done.has(clean)) return done.get(clean);
  if (nope.has(clean)) return null;
  if (loading.has(clean)) return loading.get(clean);

  const p = (async () => {
    // Template candidates: the historic <name>.js, then <name>.sh (a
    // bash command run through the transpiler), then — for a name that
    // already ends in .sh — the name itself (www/bin/mimecroft.sh).
    const candidates = [
      { tpl: clean + ".js", dest: "/bin/" + clean + ".js" },
      { tpl: clean + ".sh", dest: "/bin/" + clean + ".sh" },
    ];
    if (clean.endsWith(".sh")) candidates.push({ tpl: clean, dest: "/bin/" + clean });
    for (const { tpl, dest } of candidates) {
      let template;
      try {
        template = await loadTemplate(tpl);
      } catch {
        continue;   // not a template command by that name
      }
      // content-compare: rewrite whenever the /bin copy differs from
      // the template (the old version-marker check could be fooled by a
      // marker-less template — a stale copy would stick forever)
      try {
        const existing = await fs.read(dest);
        if (existing === template) {
          done.set(clean, dest);
          return dest;      // already current
        }
      } catch {
        // missing — fall through and write
      }
      await fs.write(dest, template);
      done.set(clean, dest);
      return dest;
    }
    nope.add(clean);   // not a template command — remember, don't retry
    return null;
  })();

  loading.set(clean, p);
  try {
    return await p;
  } finally {
    loading.delete(clean);
  }
}

// The full set of template command names (for `which`/completion
// hints), or null when not needed — kept lazy to avoid the fetch.
export const BIN_TEMPLATES = new Set([
  "sayhello", "counter", "mail", "webgldemo", "audiodemo", "arecord",
  "screen", "qbe2wasm", "perl", "lua", "time", "diff", "cowsay",
  "fortune", "figlet", "sl", "cmatrix", "at", "cron", "curl", "gzip",
  "gunzip", "plot", "magick", "ffmpeg", "typist", "md5sum", "sha256sum",
  "tar", "tree", "uptime", "zip", "sh2js", "sh2perl", "otranspiler",
  "xclip", "xeyes", "xterm", "watch", "base64", "base32", "llm",
]);
