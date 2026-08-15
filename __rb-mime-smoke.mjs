// ─── __rb-mime-smoke.mjs — the reported browser failure, reproduced
// and fixed: jtsh runs `mimecroft.sh` through runBashScript → runBash,
// and the generated JS calls process.stdout.write — with no node
// `process` in the browser, that was "process is not defined". This
// smoke test transpiles + runs the REAL mimecroft.sh through runBash
// with global process stripped (browser sim) and a "q," key stream,
// asserting the game boots, quits cleanly and never throws.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { runBash } from "./src/bash2js.js";

const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const out = [];
const err = [];
const stdout = { write: (s) => out.push(String(s)) };
const stderr = { write: (s) => err.push(String(s)) };

// browser sim: no node process (the go.js shim, when loaded, has no stdout)
const saved = globalThis.process;
globalThis.process = { versions: { node: undefined }, env: undefined, argv: [] };

// the game reads keys via /dev/webgl/key — answer "q," (quit at once)
const origRead = fs.read.bind(fs);
fs.read = async (p) => {
  const s = String(p);
  if (s.includes("webgl/key")) return "q,\n";
  if (s.includes("webgl/state")) return "headless=1\n";
  return origRead(p);
};

let code;
try {
  code = await runBash(fs, src, {
    stdout, stderr,
    runCmd: async (cmdline) => {
      // nested bash/sh2glsl for textures+shaders: absent → the game
      // falls back to embedded shaders + white textures (like the
      // headless harness)
      return { out: "", err: "", code: 127 };
    },
    args: [],
    argv0: "mimecroft.sh",
    env: { HOME: "/home", USER: "tinysh" },
  });
} catch (e) {
  console.log("RUN ERROR:", e.message);
  process.exit(1);
} finally {
  fs.read = origRead;
  globalThis.process = saved;
}

const text = out.join("") + err.join("");
const ok =
  text.includes("MIMEcroft") &&
  /Quit\. Score/.test(text) &&
  !text.includes("process is not defined");
console.log("mimecroft-via-runBash (browser sim):", ok ? "PASS" : "FAIL");
if (!ok) console.log(text.split("\n").slice(-8).join("\n"));
console.log("(exit code " + code + ")");
process.exit(ok ? 0 : 1);
