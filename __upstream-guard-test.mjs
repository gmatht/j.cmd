// ─── __upstream-guard-test.mjs — upstream reproducers in the deploy gate ─
// Runs every upstream-repros/*.sh under real bash and through the
// transpiler and requires identical stdout. Reproducers listed in
// KNOWN_OPEN are still-broken upstream bugs: their mismatch is REPORTED
// but does not fail the gate (an open upstream bug must not block an
// unrelated deploy) — while any reproducer NOT listed must match, so a
// fixed bug can never silently return.
//
//   node __upstream-guard-test.mjs   → "ALL UPSTREAM REPROS MATCH (n open)"
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fs } from "./src/fs/index.js";
import { runBash } from "./src/bash2js.js";

// Still-unfixed upstream bugs (their reproducers live in upstream-repros/).
// Remove a name here once the fix lands — the gate then pins it forever.
// every reproducer now matches real bash — a fixed one can never
// silently regress again (the suite auto-discovers upstream-repros/*.sh)
const KNOWN_OPEN = [
  // 08: an unquoted `$(…)` redirect target passes captureWords()'s ARRAY
  // straight to fs.writeFile. One word must be unwrapped; 0-or-many words
  // must be `ambiguous redirect` + status 1 with no file created. This is
  // the mechanism behind the shader-source-named junk file in the repo
  // root (see the reproducer header). Remove once the emitter collapses
  // the word list and rejects an ambiguous target.
  "08-unquoted-cmdsub-redirect-target.sh",
];

const files = readdirSync("upstream-repros").filter((f) => f.endsWith(".sh")).sort();
let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

for (const f of files) {
  const want = execFileSync("bash", [`upstream-repros/${f}`], { encoding: "utf8" });
  let got = "";
  try {
    await runBash(fs, readFileSync(`upstream-repros/${f}`, "utf8"), {
      stdout: { write: (s) => { got += s; } }, stderr: { write: (s) => { got += s; } },
      runCmd: async () => ({ out: "", err: "", code: 127 }), args: [], argv0: f,
    });
  } catch (e) { got = "THREW: " + (e && e.message ? e.message : e) + "\n"; }
  const matches = got === want;
  if (KNOWN_OPEN.includes(f)) {
    console.log(`${matches ? "PASS" : "OPEN"}: ${f} — upstream bug ${matches ? "now FIXED (remove from KNOWN_OPEN)" : "still open"}`);
  } else {
    check(`${f} matches real bash`, matches, matches ? "" : `bash=${JSON.stringify(want.trim())} transpiled=${JSON.stringify(got.trim())}`);
  }
}
const open = KNOWN_OPEN.filter((f) => files.includes(f)).length;
console.log(fails === 0 ? `ALL UPSTREAM REPROS MATCH (${open} known-open upstream bug${open === 1 ? "" : "s"})` : `${fails} UPSTREAM REPRO REGRESSION(S)`);
process.exit(fails ? 1 : 0);
