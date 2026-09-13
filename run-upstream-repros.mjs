// ─── run-upstream-repros.mjs — upstream bug reproducers, stdout-compared ─
//
// Each upstream-repros/*.sh is a SELF-CONTAINED example of a transpiler
// or runtime bug found while building mimecroft. The acceptance rule is
// simply "the transpiled shell must print what real bash prints", so the
// reproducer is also its own test: run it under host bash, run it
// through the transpiler, compare stdout.
//
// These live OUTSIDE the deploy gate: a reproducer for a still-open
// upstream bug must FAIL here without blocking a deploy of unrelated
// work. Run it by hand (or from upstream CI) to see the live set:
//
//   node run-upstream-repros.mjs          # all reproducers
//   node run-upstream-repros.mjs 01       # only names containing "01"
//
// Exit 0 = every reproducer matches real bash (all bugs fixed).
// Exit 1 = at least one still fails = a bug report ready to send upstream
//          (the failing case prints bash vs transpiled side by side).
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fs } from "./src/fs/index.js";
import { runBash } from "./src/bash2js.js";

const filter = process.argv[2] || "";
const files = readdirSync("upstream-repros").filter((f) => f.endsWith(".sh")).filter((f) => f.includes(filter)).sort();

let bad = 0, good = 0;
const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);

for (const f of files) {
  const src = readFileSync(`upstream-repros/${f}`, "utf8");
  const want = execFileSync("bash", [`upstream-repros/${f}`], { encoding: "utf8" });
  let got = "";
  try {
    await runBash(fs, src, {
      stdout: { write: (s) => { got += s; } },
      stderr: { write: (s) => { got += s; } },
      runCmd: async () => ({ out: "", err: "", code: 127 }),
      args: [], argv0: f,
    });
  } catch (e) {
    got = "THREW: " + (e && e.message ? e.message : e) + "\n";
  }
  const ok = got === want;
  if (ok) good++; else bad++;
  console.log(`${pad(ok ? "MATCH  " + f : "DIFFER " + f, 46)} bash=${JSON.stringify(want.trim())} transpiled=${JSON.stringify(got.trim())}`);
}
console.log(`\n${good}/${good + bad} reproducers match real bash` + (bad ? ` — ${bad} OPEN upstream bug(s)` : ""));
process.exit(bad ? 1 : 0);
