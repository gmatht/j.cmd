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
// -----------------------------------------------------------------

import { fs } from "./fs/index.js";

const done = new Set();   // commands already materialized/verified this session
const nope = new Set();   // commands confirmed NOT template-backed (don't retry)
const loading = new Map();   // command name → in-flight promise (dedupe)

function templateUrl(name) {
  // www/bin/<name>.js lives one level up from src/.
  return new URL("../www/bin/" + name + ".js", import.meta.url);
}

async function loadTemplate(name) {
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    const { readFileSync } = await import("node:fs");
    return readFileSync(templateUrl(name), "utf8");
  }
  const resp = await fetch(templateUrl(name));
  if (!resp.ok) throw new Error("template " + name + " not found (" + resp.status + ")");
  return resp.text();
}

// The version marker (`// <cmd> vN`) the template declares, or null.
function versionMarker(name, source) {
  const m = /\/\/\s*[\w-]+ v(\d+)/.exec(source.split("\n")[0] || "");
  return m ? m[0] : null;
}

// Ensure /bin/<name>.js exists and is current; returns the resolved
// VFS path on success, or null when there is no template for `name`.
export async function materializeBinCommand(name) {
  const clean = String(name).replace(/\.js$/, "");
  if (done.has(clean)) return "/bin/" + clean + ".js";
  if (nope.has(clean)) return null;
  if (loading.has(clean)) return loading.get(clean);

  const p = (async () => {
    let template;
    try {
      template = await loadTemplate(clean);
    } catch {
      nope.add(clean);   // not a template command — remember, don't retry
      return null;
    }
    const path = "/bin/" + clean + ".js";
    const marker = versionMarker(clean, template);
    try {
      const existing = await fs.read(path);
      if (marker && existing.includes(marker)) {
        done.add(clean);
        return path;      // already current
      }
    } catch {
      // missing — fall through and write
    }
    await fs.write(path, template);
    done.add(clean);
    return path;
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
  "tar", "tree", "uptime", "zip", "sh2js", "sh2perl", "debashc",
  "xclip", "xeyes", "xterm", "watch", "base64", "base32", "llm",
]);
