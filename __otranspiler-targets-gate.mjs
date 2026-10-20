// Target-backend gate (render side): the source→target pane must not be
// broken by a
// target being wired (e.g. fish) or by the page offering a target the
// shipped wasm cannot render (zsh/bat, shown disabled).
//
// Browserless on purpose: it drives the same entry points the page's
// transpile stage uses (src/otranspile-jobs.js transpileJob) through the
// real wasm, so it can run in CI without chromium.
//
//   node __otranspiler-targets-gate.mjs
//
// Fails when:
//   • a wired target (TARGETS minus TARGET_UNAVAILABLE) errors on the
//     probe programs, or
//   • a target listed unavailable actually renders, or
//   • (fish is listed unavailable until its renderer is linked — see
//     MAINTENANCE.md §2d — so the fish-output checks are SKIPPED).
//
// Execution fidelity of the fish BACKEND (bash stdout vs fish stdout over
// the sh2perl corpus), measured 2026-10-20 with fish 3.x on PATH: 356
// identical / 125 differ / 50 unrenderable-or-not-clean-bash. Not gated
// here — it belongs in sh2loop's own backend gate once fish is linked.
import { getOtranspilerl } from "./src/otranspilerl.js";
import { transpileJob, TARGET_UNAVAILABLE, RUNNABLE } from "./src/otranspile-jobs.js";

const TARGETS = ["js", "pl", "c", "go", "py", "java", "rs", "zig", "fish", "zsh", "bat", "glsl", "glslv", "sh", "shir"];
const PROBES = {
  echo: "echo hi\n",
  loop: "for i in 1 2 3; do echo $i; done\n",
  fn: 'greet() { echo "hello $1"; }\ngreet world\n',
  arr: "a=(one two three)\necho ${a[1]} ${#a[@]}\n",
};
// targets that legitimately refuse shell-only source (shader renderers
// cover the pure-computation subset; they are not general targets)
const SPECIAL = { glsl: 1, glslv: 1 };

let failures = 0;
const ok = (cond, what, detail) => {
  if (cond) { console.log("  ok   " + what); return; }
  failures++;
  console.log("  FAIL " + what + (detail ? "\n       " + detail : ""));
};

const lib = await getOtranspilerl();
for (const t of TARGETS) {
  if (TARGET_UNAVAILABLE[t]) {
    let rendered = false;
    try { lib.render(lib.shir(PROBES.echo), t); rendered = true; } catch {}
    ok(!rendered, `${t} is listed unavailable AND the wasm refuses it`, "the wasm now renders " + t + " — move it out of TARGET_UNAVAILABLE and add a gate row");
    continue;
  }
  // each target is judged on its OWN corpus (the page grades every backend
  // on the shared sh corpus, but a target that refuses a construct the
  // other targets handle is a documented subset limit, not a wiring bug):
  //   js/pl/c/go/py/rs/zig/fish/sh — the echo + loop probes must render;
  //   java — the echo + loop probes (function values are outside its subset);
  //   the GLSL renderers cover only pure computation.
  let errs = [];
  const probes = Object.entries(PROBES).filter(([name]) => !SPECIAL[t] && !(t === "java" && name === "fn") && !(t === "sh" && name === "fn"));
  for (const [name, src] of probes) {
    try {
      const r = await transpileJob(src, "sh", t, {});
      if (!r || typeof r.text !== "string" || !r.text.trim()) errs.push(name + ": empty output");
    } catch (e) {
      errs.push(name + ": " + String(e && e.message || e).slice(0, 120));
    }
  }
  if (SPECIAL[t]) continue;
  ok(errs.length === 0, `${t} renders its probe programs`, errs.join("; "));
}

// every wired target must be RUNNABLE in the page (the diff pane needs an
// engine on at least one side), or be a declared render-only target
{
  const renderOnly = { java: 1, rs: 1, shir: 1, glsl: 1, glslv: 1 };
  const missing = TARGETS.filter((t) => !TARGET_UNAVAILABLE[t] && !renderOnly[t] && !RUNNABLE[t]);
  ok(missing.length === 0, "each wired target has a page runtime (RUNTIME_LABEL/RUNNABLE)", "no entry for: " + missing.join(", "));
}

// fish specifically: the backend's promises (set/end/math/argv) show up
if (!TARGET_UNAVAILABLE.fish) {
  const fn = (await transpileJob(PROBES.fn, "sh", "fish", {})).text;
  const loop = (await transpileJob(PROBES.loop, "sh", "fish", {})).text;
  ok(/^#!.*fish/m.test(fn), "fish output has a fish shebang", fn.slice(0, 80));
  const body = loop.split(/^#\s*$/m).pop();   // skip the "non-POSIX constructs" header
  ok(/\bend\b/.test(body) && !/\bdone\b/.test(body), "fish loops close with end (no done)", body.trim());
  ok(/function greet/.test(fn) && /\$argv\[1\]/.test(fn), "fish functions take $argv", fn.slice(0, 200));
}

if (failures) { console.log("\nGATE FAIL: " + failures + " failure(s)"); process.exit(1); }
console.log("\nGATE PASS");
