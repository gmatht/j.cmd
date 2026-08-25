// ─── binsync: /bin template probing (last-resort name lookup) ────
//
// /bin is a traditional directory now: an OverlayFS over BinFS
// (src/fs/binfs.js) lists and serves every www/bin template from boot,
// so command resolution finds templates through the plain $PATH walk —
// no materialization step, and no pinned copies that could shadow a
// redeployed template (the old mimecroft saga).
//
// What remains here is the LAST-RESORT probe for environments where
// even the committed index.json manifest is unavailable AND the server
// serves no directory index: confirm a template exists by fetching it
// by name, and hand back its /bin path. Nothing is ever written — the
// VFS itself serves the content on the subsequent read.
//
// `rm -r /cache/bin` calls clearBinCache() to forget probe decisions
// so a newly deployed template is picked up again.
// -----------------------------------------------------------------

const nope = new Set();   // names confirmed NOT template-backed (don't retry)

function templateUrl(name) {
  // www/bin/<name> lives one level up from src/. An explicit .js/.sh
  // extension is used as-is; otherwise the historic .js suffix applies.
  const file = /\.(js|sh|mjs)$/.test(name) ? name : name + ".js";
  return new URL("../www/bin/" + file, import.meta.url);
}

async function loadTemplate(name) {
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    const { readFile } = await import("node:fs");
    return readFile(templateUrl(name), "utf8");
  }
  const resp = await fetch(templateUrl(name).href);
  if (!resp.ok) throw new Error("template " + name + " not found (" + resp.status + ")");
  return resp.text();
}

// Forget every probe decision — the next command resolve re-probes
// (the `/cache` purge calls this).
export function clearBinCache() {
  nope.clear();
}

// The /bin path of the www/bin template for `name`, or null when there
// is no template by that name. NEVER writes — with BinFS mounted at
// /bin, the resolved path reads straight through the filesystem.
export async function probeBinCommand(name) {
  const clean = String(name).replace(/\.js$/, "");
  if (nope.has(clean)) return null;
  const candidates = clean.endsWith(".sh")
    ? [clean]                                   // mimecroft.sh → www/bin/mimecroft.sh
    : [clean + ".js", clean + ".sh"];           // foo → foo.js, then foo.sh
  for (const tpl of candidates) {
    try {
      await loadTemplate(tpl);
      return "/bin/" + tpl;
    } catch {
      continue;   // not a template by that exact name
    }
  }
  nope.add(clean);   // remember, don't retry this session
  return null;
}
