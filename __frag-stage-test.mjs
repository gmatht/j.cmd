// ─── __frag-stage-test.mjs — the staged fragment program is byte-identical ─
// Regression pin for the Sep-12 black-3D outage: `emit_fragment_shader`
// stages the bash-authored fragment program to /tmp/mimecroft-frag.sh
// with single-quoted `$` payloads that must stay literal (`putb $b`,
// `b=$((b * tex_b / 128))`, `if [ "$b" -lt 0 ] …`). A lift that rewrites
// those payloads to native interpolations stages the WRONG bytes (the
// game staged `putb ` — an empty $b — and every block rendered black)
// while every other gate stayed green: no test read the staged file.
//
// The test extracts the REAL function from www/bin/mimecroft.sh,
// drives it under real bash (stubbed sh2glsl, isolated output path)
// and through the transpiler (stubbed runCmd, VFS output path), and
// requires byte-identical staging across four effect configurations
// (CRT/corruption on/off — every branch of the emitter). The explicit
// `putb $b` spot checks name the black-3D signature so a future failure
// points at the cause, not just a byte offset.
//
// What this pins — and what it does not: the byte comparison pins the
// lowering contract (echo/redirect/branch/test/arith emission + VFS
// file writes) on this exact code, in either pipeline (it passes on the
// week-ago tree too). It cannot reproduce the Sep-12 divergence itself:
// that needed the full game, where `b` also has store writes that one
// lift converted while another missed. The full-game half of the pin
// lives in __mime-test.mjs ("staged fragment keeps putb $b").
//
//   node __frag-stage-test.mjs   → "ALL FRAG-STAGE CHECKS PASSED"
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fs } from "./src/fs/index.js";
import { runBash } from "./src/bash2js.js";

let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };

const gameSrc = readFileSync("www/bin/mimecroft.sh", "utf8");
function extract(name, src) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l === name + "() {");
  if (start < 0) throw new Error("function not found: " + name);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error("function end not found: " + name);
  return lines.slice(start, end + 1).join("\n");
}
const fnSrc = extract("emit_fragment_shader", gameSrc);
check("extracted the real emitter", fnSrc.includes("putb $b") && fnSrc.split("\n").length > 100);

// the staged path is constant text (/tmp/mimecroft-frag.sh) — rewrite it
// to an isolated path per side so configs never collide and the host
// /tmp is never clobbered. Same constant, same semantics.
const VFS_FRAG = "/tmp/frag-stage-test.sh";

// CRT/corruption × display size: every branch of the emitter.
const CONFIGS = [
  [0, 0, 800, 600],
  [1, 0, 800, 600],
  [0, 1, 320, 200],
  [1, 1, 1024, 768],
];

for (const [crt, corrupt, W, H] of CONFIGS) {
  const tag = `CRT=${crt} CORRUPT=${corrupt} ${W}x${H}`;
  const dir = mkdtempSync(join(tmpdir(), "fragstage-"));
  const hostFrag = join(dir, "frag.sh");
  const setup = `CRT_ON=${crt}\nCORRUPT_ON=${corrupt}\ndisp_w=${W}\ndisp_h=${H}\n`;
  // bash oracle: stub the sh2glsl compile (glsl="" skips the device
  // write — only the staging is under test).
  execFileSync("bash", ["-c", `sh2glsl() { printf ''; }\n` + setup +
    fnSrc.split("/tmp/mimecroft-frag.sh").join(hostFrag) + "\nemit_fragment_shader\n"]);
  const want = readFileSync(hostFrag, "utf8");
  // transpiled shell: same function, same setup, stubbed command bridge.
  let out = "";
  await runBash(fs, setup + fnSrc.split("/tmp/mimecroft-frag.sh").join(VFS_FRAG) + "\nemit_fragment_shader\n", {
    stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
    runCmd: async () => ({ out: "", err: "", code: 0 }), args: [], argv0: "frag-stage-test",
  });
  const got = String(await fs.read(VFS_FRAG));
  check(`staging byte-identical (${tag})`, got === want,
    got === want ? `${want.length} bytes` :
      `bytes ${want.length}/${got.length}; ` + (() => {
        const a = want.split("\n"), b = got.split("\n");
        const diffs = [];
        for (let i = 0; i < Math.max(a.length, b.length) && diffs.length < 3; i++) {
          if (a[i] !== b[i]) diffs.push(`line ${i}: bash=${JSON.stringify(a[i])} transpiled=${JSON.stringify(b[i])}`);
        }
        return diffs.join(" | ");
      })());
  if (crt === 1) {
    // the black-3D signature, named explicitly: these payloads must reach
    // the staged file with their `$` intact, never evaluated.
    check(`putb $b survives (${tag})`, got.includes("putb $b"));
    check(`putb $r/$g survive (${tag})`, got.includes("putb $r") && got.includes("putb $g"));
    check(`clamp keeps $b (${tag})`, got.includes('if [ "$b" -lt 0 ]; then b=0; fi'));
    // ...while the double-quoted displayCentre DOES evaluate now.
    check(`vx centre evaluated (${tag})`, got.includes(`vx=$((fx - ${W / 2}))`));
  }
}

console.log(fails === 0 ? "ALL FRAG-STAGE CHECKS PASSED" : `${fails} FRAG-STAGE CHECKS FAILED`);
process.exit(fails ? 1 : 0);
