// ─── busybox: the unified transpiler frontend (one merged Go binary) ─
//
// Every non-sh source frontend (go, py, c, pl, zsh, fish, bat) is a plain Go
// program vendored in www/bin/<frontend>/. The browser Go toolchain
// builds a SINGLE stdlib-only file out of all EIGHT frontend libraries
// + the shared A1 JSON emitter (shir-emit-go) + the dispatcher CLI, so
// one artifact serves every source language:
//
//   source ──busybox──▶ A1 shIR JSON ──otranspilerl──▶ any target
//
// This module owns the merge + build/cache dance so both the shell
// command (www/bin/otranspiler.js) and the web GUI (www/otranspiler.html)
// share one implementation:
//
//   ensureBusyboxWasm() → VFS path of the merged frontend wasm
//     (prefer the prebuilt www/wasm-bin/otranspiler-busybox.wasm; if it
//     is missing, build it on first use with the in-browser Go toolchain
//     and cache the merged source in /tmp/otranspiler-busybox/)
//   busyboxA1(source, srcLang) → parsed A1 shIR JSON contract
// -----------------------------------------------------------------

const FRONTEND_DIRS = { bat: "bat-sh-go", c: "c-sh-go", fish: "fish-sh-go", go: "go-sh", pl: "perl-sh-go", py: "py-sh-go", sh: "posix-sh-go", zsh: "zsh-sh-go" };
const FRONTEND_FILES = {
  bat:  ["bat.go"],
  c:    ["main.go"],
  fish: ["fish-sh-go.go"],
  go:   ["go-sh.go"],
  pl:   ["main.go"],
  py:   ["main.go"],
  sh:   ["main.go", "analysis.go", "lowering.go"],
  zsh:  ["main.go", "analysis.go", "lowering.go"],
};
const PREFIX_MAIN = { sh: true };                  // posix-sh-go's main() → sh_main (dispatcher owns main)
const DISPATCH_CLI = "busybox/main.go";            // the merged CLI (browser dispatcher)
const SHIR_EMIT = "shir-emit-go/emit.go";
const SCRATCH = "/tmp/otranspiler-busybox";
const PREBUILT = "wasm-bin/otranspiler-busybox.wasm";  // shipped static build
// cache-buster — bump whenever www/wasm-bin/otranspiler-busybox.wasm
// changes so a browser never reuses a stale staged copy (the staged
// VFS file at /usr/bin/otranspiler-busybox.wasm persists across page
// loads; ensureBusyboxWasm re-fetches when this version differs).
export const BUSYBOX_VERSION = "v28-cfor";  // v28: c-sh-go emits ForInit + first-class Break/Continue  // v27: user-fn for/seq decls, non-cast param lift, ptr-param index via mem seam

// Read one vendored frontend source file (browser: fetch; node: disk).
// `base` is unused in node (paths resolve against the repo root); in the
// browser it's the www/ URL prefix relative to this module.
async function readVendoredFile(base, name) {
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    const { readFile } = await import("node:fs/promises");
    return await readFile(process.cwd() + "/www/bin/" + name, "utf8");
  }
  // Browser (the in-browser build fallback): try the page-relative
  // www/bin/ path first (the page always lives in www/), then
  // module-relative — same rule as GoRunner._fetch (src/go.js). The
  // old code resolved against src/ only, which 404s everywhere.
  const candidates = [];
  try { candidates.push(new URL("bin/" + name, location.href).href); } catch {}
  try { candidates.push(new URL("bin/" + name, new URL(base + "/", import.meta.url)).href); } catch {}
  let lastErr = null;
  for (const href of candidates) {
    try {
      const resp = await fetch(href);
      if (resp.ok) return resp.text();
      lastErr = new Error("vendored frontend source not found (" + resp.status + "): " + name);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("vendored frontend source not found: " + name);
}

function stripPkg(s) {
  return s.split("\n").filter(function (ln) { return !/^package \w+\s*$/.test(ln); }).join("\n");
}
function stripImports(s) {
  return s
    .replace(/import \(\n[\s\S]*?\n\)\n?/, "")
    .replace(/^import "[^"]+"\s*\n?/m, "");
}
function extractImports(s) {
  const m = s.match(/import \(\n([\s\S]*?)\n\)/);
  if (!m) return [];
  return m[1].split("\n").map((x) => x.trim())
    .filter((x) => /^"[^"]+"$/.test(x))
    .map((x) => x.slice(1, -1));
}

// Rename every top-level decl (and its identifier references) with a
// prefix, skipping string/char/raw-string literals and // comments.
function prefixBody(s, pre, prefixMain) {
  const names = new Set();
  let inBlock = false;
  for (const ln of s.split("\n")) {
    const t = ln.trim();
    const m = ln.match(/^(?:func|type|var|const)\s+([A-Za-z_]\w*)/);
    if (m && (m[1] !== "main" || prefixMain)) names.add(m[1]);
    if (/^(?:var|const)\s*\(\s*$/.test(t)) { inBlock = true; continue; }
    if (t === ")") { inBlock = false; continue; }
    if (inBlock) {
      const bm = ln.match(/^\s*([A-Za-z_]\w*)/);
      if (bm && bm[1] !== "_") names.add(bm[1]);
    }
  }
  let out = "";
  let state = "code"; // code | dq | sq | raw | line
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (state === "dq" || state === "sq" || state === "raw") {
      out += ch;
      if (ch === "\\" && state !== "raw") { out += s[i + 1] || ""; i += 2; continue; }
      const close = state === "dq" ? '"' : state === "sq" ? "'" : "`";
      if (ch === close) state = "code";
      i++;
      continue;
    }
    if (state === "line") {
      out += ch;
      if (ch === "\n") state = "code";
      i++;
      continue;
    }
    if (ch === '"') { state = "dq"; out += ch; i++; continue; }
    if (ch === "'") { state = "sq"; out += ch; i++; continue; }
    if (ch === "`") { state = "raw"; out += ch; i++; continue; }
    if (ch === "/" && s[i + 1] === "/") { state = "line"; out += "//"; i += 2; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const word = s.slice(i, j);
      out += names.has(word) ? pre + word : word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Merge the eight frontend libraries + the A1 emitter + the dispatcher
// CLI into a single stdlib-only main.go. `base` = www/ base (URL in
// browser, path prefix in node).
export async function mergedBusyboxSource(base) {
  const parts = [];
  const impSet = {};
  const allSrc = [];
  for (const lang of Object.keys(FRONTEND_FILES)) {
    const dir = FRONTEND_DIRS[lang];
    let body = "";
    for (const f of FRONTEND_FILES[lang]) {
      const src = await readVendoredFile(base, dir + "/" + f);
      allSrc.push(src);
      body += (body ? "\n" : "") + stripImports(stripPkg(src));
    }
    parts.push(prefixBody(body.replace(/shiremit\./g, "shiremit_"), lang + "_", PREFIX_MAIN[lang]));
  }
  const emit = await readVendoredFile(base, SHIR_EMIT);
  allSrc.push(emit);
  parts.push(prefixBody(stripImports(stripPkg(emit)), "shiremit_"));
  const cli = await readVendoredFile(base, DISPATCH_CLI);
  allSrc.push(cli);
  parts.push(prefixBody(stripImports(stripPkg(cli)), "cli_"));
  allSrc.forEach((f) => {
    extractImports(f).forEach((i) => { impSet[i] = true; });
  });
  const imports = Object.keys(impSet).sort();
  return (
    "// Generated unified frontend (busybox): eight frontend libs + shir-emit-go + the dispatcher CLI.\n" +
    "// Source of truth: gmatht/sh2loop/frontends, vendored in www/bin/.\n" +
    "package main\n\n" +
    "import (\n" + imports.map((i) => '\t"' + i + '"').join("\n") + "\n)\n\n" +
    parts.join("\n") + "\n"
  );
}

// VFS helpers (browser fs object / CLI VirtualFS share this shape).
async function vfsRead(fs, p) { return await fs.read(p); }
async function vfsWrite(fs, p, s) { return await fs.write(p, s); }
async function vfsStat(fs, p) { try { return await fs.stat(p); } catch { return null; } }

// Build (once) the merged frontend with the in-browser Go toolchain and
// cache it in /tmp. Returns the VFS path of the frontend wasm.
export async function buildBusybox(fs, goRunner, goCmd, onLog) {
  const log = onLog || (() => {});
  const merged = await mergedBusyboxSource("");
  const mainPath = SCRATCH + "/main.go";
  const wasmPath = SCRATCH + "/main.wasm";
  const st = await vfsStat(fs, mainPath);
  let fresh = false;
  if (st) {
    try { fresh = (await vfsRead(fs, mainPath)) === merged; } catch { fresh = false; }
  }
  if (!fresh) {
    await vfsWrite(fs, mainPath, merged);
    const prevCwd = fs.cwd;
    try {
      fs.cwd = SCRATCH;
      log("building the unified frontend (first run — go toolchain, ~30 s)…");
      const code = await goCmd(["build", "main.go"]);
      if (code !== 0) throw new Error("frontend build failed (go build exit " + code + ")");
    } finally {
      fs.cwd = prevCwd;
    }
  }
  const w = await vfsStat(fs, wasmPath);
  if (!w) throw new Error("frontend wasm missing after build");
  return wasmPath;
}

// Return the VFS path of a usable busybox frontend wasm. Prefers the
// prebuilt static binary (www/wasm-bin/otranspiler-busybox.wasm) — no
// in-browser Go build needed. Falls back to building on first use.
// `fetchBytes(url) → Uint8Array` stages the prebuilt wasm into the VFS.
export async function ensureBusyboxWasm(fs, { goRunner, goCmd, fetchBytes, onLog } = {}) {
  const log = onLog || (() => {});
  const PREBUILT_VFS = "/usr/bin/otranspiler-busybox.wasm";
  const VER_VFS = PREBUILT_VFS + ".ver";
  let st = await vfsStat(fs, PREBUILT_VFS);
  // Re-stage when the staged copy is missing OR built by an older
  // busybox (the version marker is written alongside the wasm).
  let stagedVer = null;
  try { stagedVer = await fs.read(VER_VFS); } catch {}
  if ((!st || stagedVer !== BUSYBOX_VERSION) && fetchBytes) {
    try {
      const bytes = await fetchBytes(PREBUILT + "?v=" + BUSYBOX_VERSION);
      await fs.writeBlob(PREBUILT_VFS, new Blob([bytes]));
      try { await fs.write(VER_VFS, BUSYBOX_VERSION); } catch {}
      st = await vfsStat(fs, PREBUILT_VFS);
      log("using prebuilt busybox frontend (" + (bytes.byteLength / 1024).toFixed(0) + "K, " + BUSYBOX_VERSION + ")");
    } catch (e) {
      log("prebuilt busybox unavailable (" + e.message + ") — building from source");
    }
  }
  if (st) return PREBUILT_VFS;
  if (!goRunner || !goCmd) throw new Error("no prebuilt busybox and no Go toolchain available");
  return await buildBusybox(fs, goRunner, goCmd, log);
}

// Parse the A1 shIR JSON contract for a source language via the merged
// frontend. Throws with the frontend's diagnostics on failure.
export async function busyboxA1(source, srcLang, { fs, wasmPath, goRunner, onLog } = {}) {
  const log = onLog || (() => {});
  const inputPath = "/tmp/otranspiler-in." + (srcLang === "shir" ? "shir" : srcLang);
  await vfsWrite(fs, inputPath, source);
  const lang = srcLang === "pl" ? "perl" : srcLang;   // dispatcher lang names
  log("parsing " + srcLang + " source → A1 shIR…");
  const r = await goRunner.runModule(wasmPath, ["main.wasm", "--lang", lang, "--shir", inputPath, "--raw"]);
  const out = String(r.stdout || "").trim();
  const rerr = String(r.stderr || "").trim();
  if (r.code !== 0) {
    throw new Error((srcLang || "") + " frontend: " + (out || rerr || ("exit " + r.code)).slice(0, 300));
  }
  const start = out.indexOf("{");
  if (start < 0) throw new Error((srcLang || "") + " frontend: no A1 contract in output: " + out.slice(0, 120));
  return JSON.parse(out.slice(start));
}
