// Busybox smoke gate for otranspiler.html's parsing stage.
//
// Drives EXACTLY the path the page uses — ensureBusyboxWasm() stages the
// prebuilt www/wasm-bin/otranspiler-busybox.wasm into the VFS, then
// busyboxA1(source, lang) parses it with the merged frontend — over every
// corpus file www/examples/<dir>/index.json lists for that language.
//
// A file passes when the frontend returns an A1 program (exit 0, JSON
// with "contract_version"). A frontend-level refusal (exit != 0, i.e. a
// "language-subset" diagnostic) is reported separately from a wasm
// failure (runner error, no JSON, truncated output) — the latter is
// always a gate failure.
//
// Usage (from the repo root; needs a browser-less node):
//   node __busybox-corpus-gate.mjs                      # every language
//   node __busybox-corpus-gate.mjs --lang py,go         # a subset
//   node __busybox-corpus-gate.mjs --changed-from wasm  # also diff against
//        a reference wasm (e.g. `git show HEAD:www/wasm-bin/… > /tmp/old.wasm`)
//        and list every example whose A1 JSON changed
//   --limit N caps files per language; --fail-on-refuse makes intentional
//   frontend refusals (unsupported subset features) fail the gate too
//
// Exit 0 = no broken parses.
import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { GoRunner } from "./src/go.js";
import { ensureBusyboxWasm, busyboxA1, BUSYBOX_VERSION } from "./src/busybox.js";

const DIRS = {
  py: "py", go: "go", c: "c", cpp: "cpp", pl: "pl",
  bat: "bat", fish: "fish", zsh: "zsh", zig: "zig",
};
const langs = Object.keys(DIRS);
const only = process.argv.includes("--lang")
  ? process.argv[process.argv.indexOf("--lang") + 1].split(",")
  : langs;
const limit = process.argv.includes("--limit")
  ? Number(process.argv[process.argv.indexOf("--limit") + 1])
  : Infinity;
const failOnRefuse = process.argv.includes("--fail-on-refuse");
const refWasmPath = process.argv.includes("--changed-from")
  ? process.argv[process.argv.indexOf("--changed-from") + 1]
  : null;

const goRunner = new GoRunner(fs, { baseUrl: "www/" });
const fetchBytes = async () =>
  new Uint8Array(readFileSync("www/wasm-bin/otranspiler-busybox.wasm"));
const wasmPath = await ensureBusyboxWasm(fs, { fetchBytes, onLog: (m) => console.log("LOG:", m) });
console.log("busybox", BUSYBOX_VERSION, "→", wasmPath);
let refWasm = null;
if (refWasmPath) {
  refWasm = await ensureBusyboxWasm(fs, {
    fetchBytes: async () => new Uint8Array(readFileSync(refWasmPath)),
    onLog: () => {},
  });
}

let failures = 0;
const summary = [];
for (const lang of only) {
  const dir = DIRS[lang];
  let files;
  try {
    files = JSON.parse(readFileSync(`www/examples/${dir}/index.json`, "utf8"));
    if (!Array.isArray(files)) files = files.files || [];
  } catch (e) {
    console.log(`${lang}: no index.json (${e.message}) — skipped`);
    continue;
  }
  let ok = 0, refused = 0, broken = 0;
  const changed = [];
  const refuseMsgs = [];
  for (const name of files.slice(0, limit)) {
    const src = readFileSync(`www/examples/${dir}/${name}`, "utf8");
    try {
      const a1 = await busyboxA1(src, lang, { fs, wasmPath, goRunner });
      if (!a1 || a1.type !== "Program" || a1.contract_version !== 1) {
        throw new Error("not an A1 Program: " + JSON.stringify(a1).slice(0, 120));
      }
      ok++;
      if (refWasm) {
        let ref = null;
        try { ref = JSON.stringify(await busyboxA1(src, lang, { fs, wasmPath: refWasm, goRunner })); } catch {}
        if (ref !== JSON.stringify(a1)) changed.push(name);
      }
    } catch (e) {
      const msg = String(e && e.message || e);
      // a frontend refusal names the frontend and reports a parse error
      const isRefusal = /frontend: (parse|lower|emit)?:?/i.test(msg) && !/no A1 contract/.test(msg);
      if (isRefusal) { refused++; if (refuseMsgs.length < 3) refuseMsgs.push(name + ": " + msg.slice(0, 140)); }
      else { broken++; console.log(`  BROKEN ${lang}/${name}: ${msg.slice(0, 220)}`); }
    }
  }
  failures += broken + (failOnRefuse ? refused : 0);
  for (const m of refuseMsgs) console.log(`  refuse ${lang}: ${m}`);
  summary.push({ lang, total: files.length, ok, refused, broken, ...(refWasm ? { changed } : {}) });
  console.log(`${lang.padEnd(5)} ${String(ok).padStart(4)} ok / ${files.length}  (${refused} refused, ${broken} broken)` +
    (refWasm ? `  changed vs reference: ${changed.length}${changed.length ? " → " + changed.slice(0, 8).join(", ") : ""}` : ""));
}
console.log("\n" + JSON.stringify(summary));
if (failures) { console.log(`GATE FAIL: ${failures} failure(s)`); process.exit(1); }
console.log("GATE PASS");
