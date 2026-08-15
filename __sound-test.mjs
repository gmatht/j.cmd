// ─── __sound-test.mjs — the --sounds notes|bash backend ──────────
// 1) parseSamplesPayload (src/fs/audiodev.js — the /dev/audio/samples
//    decoder) accepts the sound-script TSV and the bare "RATE N …"
//    form, and rejects garbage
// 2) every examples/sounds/sound-*.sh generator runs under real bash:
//    TSV header shape, sample count, --material, determinism
// 3) mimecroft --sounds bash end-to-end: transpile the game (browser
//    path forced so sound=1), toggle SOUND MODE → BASH in the settings
//    menu, shoot, and verify /dev/audio/samples receives the generated
//    TSV and the /tmp cache is written — plus a run driven by the
//    --sounds bash CLI arg alone
//
//   node __sound-test.mjs   → "ALL SOUND CHECKS PASSED"
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { execFileSync } from "node:child_process";
import { parseSamplesPayload } from "./src/fs/audiodev.js";

const T0 = Date.now();
let fails = 0;
const check = (n, c, x = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${n}${x ? " — " + x : ""}`); if (!c) fails++; };
const tssvCount = (tsv) => { const m = /samples\t(\d+)\t/.exec(tsv); return m ? m[1] : "0"; };

// ─── 1) the /dev/audio/samples decoder ────────────────────────────
console.log("parseSamplesPayload…");
{
  const tsv = execFileSync("bash", ["examples/sounds/sound-hit.sh", "--tsv"], { encoding: "utf8" });
  const p = parseSamplesPayload(tsv);
  const count = parseInt(tssvCount(tsv), 10);
  check("TSV: rate 22050", p.rate === 22050, String(p.rate));
  check("TSV: sample count matches header", p.samples.length === count, `${p.samples.length} vs ${count}`);
  check("TSV: samples are int16", p.samples.every((v) => v >= -32768 && v <= 32767));

  const bare = parseSamplesPayload("22050 4 1 -2 30000 -32768");
  check("bare RATE N … form", bare.rate === 22050 && bare.samples.length === 4 && bare.samples[2] === 30000 && bare.samples[3] === -32768);

  let threw = false;
  try { parseSamplesPayload("garbage"); } catch { threw = true; }
  check("garbage payload throws", threw);
  threw = false;
  try { parseSamplesPayload("22050 5 1 2 3"); } catch { threw = true; }
  check("short payload throws", threw);
}

// ─── 2) the generators under real bash ─────────────────────────────
// Per-sample integer DSP in bash is slow (the 460 ms treasure is 10K
// samples ≈ 22 s) — one pass over all ten, then determinism on a fast
// representative (the LCG seed path is shared, so one is enough).
console.log(`  [t=${((Date.now()-T0)/1000).toFixed(1)}s] generators (real bash)…`);
const SOUNDS = ["hit", "break", "thud", "shoot", "kill", "damage", "treasure", "shatter", "walk", "mime"];
const tsvBySound = {};
for (const s of SOUNDS) {
  const tsv = execFileSync("bash", [`examples/sounds/sound-${s}.sh`, "--tsv"], { encoding: "utf8" });
  tsvBySound[s] = tsv;
  const okHdr = tsv.startsWith(`#sound\t${s}\t22050\tseed\t`);
  const okN = parseSamplesPayload(tsv).samples.length === parseInt(tssvCount(tsv), 10);
  if (!okHdr || !okN) { fails++; console.log(`  FAIL ${s}: bad TSV (hdr=${okHdr} count=${okN})`); }
  else console.log(`  ok  ${s}: TSV header + ${tssvCount(tsv)} samples`);
}
check("generators deterministic (hit ×2)", execFileSync("bash", ["examples/sounds/sound-hit.sh", "--tsv"], { encoding: "utf8" }) === tsvBySound.hit);

// the material ladder: each hit material is a different sample list
const mats = ["stone", "dirt", "wood", "gold", "gem"];
const matTsVs = mats.map((m) => execFileSync("bash", ["examples/sounds/sound-hit.sh", "--tsv", "--material", m], { encoding: "utf8" }));
check("hit --material gives 5 distinct lists", new Set(matTsVs).size === 5);

// shatter's --notes echo the game's two shot_treasure play() calls
const shatterNotes = execFileSync("bash", ["examples/sounds/sound-shatter.sh", "--notes"], { encoding: "utf8" });
check("shatter --notes → the two game notes", shatterNotes.includes('play "C4 0.12"') && shatterNotes.includes('play "E2 0.18"'));

// ─── 3) mimecroft --sounds bash, end to end ───────────────────────
// The transpiled game reads keys through sh2.fs.readFile (the estree
// lowers `$(cat /dev/webgl/key)` to a direct fs read), writes through
// fs.write, and echoes through process.stdout.write — so the harness
// patches fs.read/fs.write and passes a process shim to the Function.
async function runGame(args, keys, opts = {}) {
  let src = readFileSync("examples/mimecroft.sh", "utf8");
  if (!opts.precache) {
    // the runs below assert the LAZY generation counts (one generator
    // run per distinct sound) — disable the background pre-cache so the
    // in-game plays drive the generators, exactly as before the
    // feature. The dedicated pre-cache run turns it back on.
    src = src.replace("precache_sounds &", "true");
  }
  // force the browser path AND keep sound on (the headless branch sets
  // sound=0 — the CLI has no Web Audio)
  src = src.replace("*headless*) sound=$((0)); headless=1 ;;", "*headless*) sound=$((1)); headless=0 ;;").replace(
    "    load_textures\n    echo \"  generating treasure labels…\"\n    load_labels\n    echo \"  generating mime banners…\"\n    load_mime_labels\n",
    // the sounds don't depend on the block/label textures — skip the
    // slow host-bash texture generation so the run stays fast
    "    echo \"  textures skipped (sound test)…\"\n").replace(
    // a material-aware hit sound at startup: the first in-game shot
    // always hits the obsidian border (thud), so this exercises the
    // play_sound "hit-<material>" → sound-hit.sh --material path
    "  frame=$((0))\n  quit=$((0))\n",
    "  frame=$((0))\n  quit=$((0))\n  play \"C3 0.05\" stone\n");
  const { js } = await bashToJS(fs, src);

  let keyFrame = 0;
  const samplesWrites = [];        // { path, content } for /dev/audio/samples
  const soundRuns = [];            // generator invocations (host bash)

  const origRead = fs.read.bind(fs);
  fs.read = async (path, opts) => {
    const p = fs._resolve(path);
    if (p === "/dev/webgl/key") {
      const k = (keyFrame < keys.length ? keys[keyFrame] : "q,") + "\n";
      keyFrame++;
      return k;
    }
    return origRead(path, opts);
  };
  const origW = fs.write.bind(fs);
  fs.write = async (path, content) => {
    const p = fs._resolve(path);
    if (p === "/dev/audio/samples") {
      samplesWrites.push(String(content));
      // the Node harness has no AudioContext — the browser device plays
      // the buffer; here just swallow the playback error (the WRITE and
      // the cache are what the assertions check).
      try { await origW(path, content); } catch {}
      return;
    }
    return origW(path, content);
  };
  const shellExec = async (cmdline) => {
    const cl = cmdline.trim(); const cmd = cl.split(/\s+/)[0];
    const rest = cl.slice(cmd.length).trim();
    let out = "";
    if (cmd === "bash" || cmd === "/bin/bash") {
      // textures (bash) and sounds (/bin/bash) both run host bash here
      const args2 = rest.split(/\s+/).map((a) => a.replace("/examples/", "examples/"));
      const name = (args2[0] || "").split("/").pop();
      if (name.startsWith("sound-") && name.endsWith(".sh")) soundRuns.push(args2.join(" "));
      // the transpiled path stages the generator as a VFS file
      // (/tmp/sound-<name>.sh — lib+script in one chunk); host bash can't
      // see the VFS, so run the CONTENT with the args (the browser runs
      // the file through the transpiled bash builtin instead)
      let vfsSrc = null;
      try { vfsSrc = await fs.read(args2[0]); } catch {}
      if (vfsSrc !== null && vfsSrc !== undefined) {
        // the browser's `bash /tmp/sound-*.sh` is the TRANSPILED builtin —
        // run the staged generator through the real transpiled path (the
        // runtime transforms: arith, eval, test-arith), not host bash, so
        // the test validates the actual generation AND stays fast
        const { runBash } = await import("./src/bash2js.js");
        let runOut = "";
        await runBash(fs, String(vfsSrc), {
          stdout: { write: (s) => { runOut += s; } },
          stderr: { write: (s) => { runOut += s; } },
          runCmd: async () => ({ out: "", err: "", code: 127 }),
          args: args2.slice(1), argv0: args2[0],
        });
        out = runOut;
      } else {
        try { out = execFileSync("bash", args2, { encoding: "utf8" }); } catch { out = ""; }
      }
    }
    else if (cmd === "sh2glsl") { out = ""; }
    else if (cmd === "cat") {
      // the game's staging reads the generators via `$(cat …)` — keep
      // the ABSOLUTE VFS path (the /examples → examples strip is for
      // host-bash argv, not the VFS read)
      const p = rest.split(/\s+/)[0];
      try { out = String(await fs.read(p)); } catch { out = ""; }
    }
    else if (cmd === "true") {}
    else out = `${cmd}: command not found\n`;
    return { out, err: "", code: 0 };
  };
  const stdout = [];
  const out = { write: (s) => stdout.push(s) };
  const proc = {
    stdout: out,
    stderr: { write: (s) => stdout.push("[err] " + s) },
    pid: 1, argv: ["bash", ...args], env: {},
    cwd: () => "/", chdir() {},
    exit() {},
  };
  const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: proc.stderr, args, argv0: "bash" });
  const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "process", "return (async () => { " + js + " })();");
  try {
    // a samples write in the Node harness throws "audio not available"
    // (there is no AudioContext) — the browser device plays it; the
    // assertions only need the WRITE + cache, so swallow the playback
    // error the same way the real shell's per-command handling does.
    await fn([], fs, {}, out, proc.stderr, shellExec, rt.sh2, proc);
  } catch (e) {
    const m = String(e && e.message ? e.message : e);
    if (!m.includes("audio not available")) throw e;
  } finally {
    fs.read = origRead;
    fs.write = origW;
  }
  return { samplesWrites, soundRuns, stdout };
}

// menu path: 7×ArrowDown to SOUND MODE, ArrowRight → BASH, Escape, then
// space (shoot) twice, q (quit)
const menuKeys = Array(7).fill("ArrowDown,").concat(["ArrowRight,", "Escape,", "space,", "space,", "q,"]);
console.log(`  [t=${((Date.now()-T0)/1000).toFixed(1)}s] game run 1 (menu toggle)…`);
{
  const { samplesWrites, soundRuns, stdout } = await runGame([], menuKeys);
  check("samples device received at least one sound", samplesWrites.length >= 1, "writes=" + samplesWrites.length);
  const names = samplesWrites.map((c) => /^#sound\t(\w+)\t/.exec(c)?.[1]).filter(Boolean);
  check("payloads are valid sound TSVs", names.length === samplesWrites.length && names.every(Boolean), names.join(","));
  check("a bash sound played", ["hit", "break", "thud", "shoot"].includes(names[0]), names[0]);
  // the generator ran once per distinct sound and its TSV is cached
  const distinct = [...new Set(names)];
  check("generator invoked once per distinct sound", soundRuns.length === distinct.length, `runs=${soundRuns.length} distinct=${distinct.length}`);
  // the cache key is the script name + material suffix: sound-hit.sh
  // --material stone → /tmp/mimecroft-snd-hit-stone.tsv
  const cacheKeys = soundRuns.map((r) => {
    const m = /sound-([a-z]+)\.sh/.exec(r);
    const name = m ? m[1] : "";
    const mat = /--material (\w+)/.exec(r);
    return mat ? `${name}-${mat[1]}` : name;
  });
  const caches = await Promise.all(cacheKeys.map((n) => fs.stat(`/tmp/mimecroft-snd-${n}.tsv`).then(() => true).catch(() => false)));
  check("sound caches written to /tmp", caches.every(Boolean), cacheKeys.join(","));
  check("menu printed the bash mode", stdout.join("").includes("sound mode  : BASH"));
  // the material-aware hit: "hit-stone" ran sound-hit.sh --material stone
  const hitRun = soundRuns.find((r) => r.includes("sound-hit.sh"));
  check("hit material maps to sound-hit.sh --material", !!hitRun && hitRun.includes("--material stone"), hitRun || "no hit run");
  check("material hit cache written", (await fs.stat("/tmp/mimecroft-snd-hit-stone.tsv").then(() => true).catch(() => false)));
}

// CLI-arg path: --sounds bash straight from the command line. The run
// shares the SAME /tmp (in-process RamFS), so its shot must reuse the
// cache the menu run wrote — zero generator invocations.
console.log(`  [t=${((Date.now()-T0)/1000).toFixed(1)}s] game run 2 (CLI arg)…`);
{
  const keys = ["Escape,", "space,", "q,"];
  const { samplesWrites, soundRuns, stdout } = await runGame(["--sounds", "bash"], keys);
  check("samples device received a sound", samplesWrites.length >= 1, "writes=" + samplesWrites.length);
  check("startup echo shows bash mode", stdout.join("").includes("sound bash"));
  check("cache reused across runs (no re-generation)", soundRuns.length === 0, `runs=${soundRuns.length}`);
}

// Background pre-cache: as soon as bash sounds are enabled, the game
// warms the /tmp sound cache in the background — the first play of
// each sound is then a cache hit instead of a generator run. The list
// starts with the sounds the opening minutes play (hit + its five
// materials, then thud), so clear the in-process cache from the runs
// above, run the game with the pre-cache ON, and assert those land
// without the game hanging (the generator invocations happen detached).
console.log(`  [t=${((Date.now()-T0)/1000).toFixed(1)}s] game run 3 (background pre-cache)…`);
{
  // drop the caches runs 1-2 wrote, so the pre-cache does the work
  for (const n of (await fs.list("/tmp") || [])) {
    if (String(n).startsWith("mimecroft-snd-")) { try { await fs.remove("/tmp/" + n); } catch {} }
  }
  const keys = ["Escape,", "space,", "q,"];
  const { soundRuns } = await runGame(["--sounds", "bash"], keys, { precache: true });
  // the opening sounds the pre-cache list puts first: hit + materials
  const PRECACHE_FIRST = ["hit", "hit-stone", "hit-dirt", "hit-wood", "hit-gold", "hit-gem"];
  const deadline = Date.now() + 90000;
  let got = [];
  while (Date.now() < deadline) {
    got = [];
    for (const n of PRECACHE_FIRST) {
      if (await fs.stat(`/tmp/mimecroft-snd-${n}.tsv`).then(() => true).catch(() => false)) got.push(n);
    }
    if (got.length === PRECACHE_FIRST.length) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check("pre-cache warmed the opening sounds (hit + materials)", got.length === PRECACHE_FIRST.length, got.join(","));
  check("pre-cache ran the generators in the background", soundRuns.length >= PRECACHE_FIRST.length, `runs=${soundRuns.length}`);
  // a cached sound plays without re-generating: play the material hit
  // again — the pre-cache already wrote it, so no new generator run
  const { soundRuns: r2Runs } = await runGame(["--sounds", "bash"], ["Escape,", "q,"], { precache: true });
  const hitStone = (r2Runs || []).filter((r) => r.includes("sound-hit.sh")).length;
  check("pre-cached sound plays without re-generating", hitStone === 0, "hit runs=" + hitStone);
}

if (fails) { console.log(`  [t=${((Date.now()-T0)/1000).toFixed(1)}s] FAILED`); console.log(`\nSOUND CHECKS FAILED: ${fails}`); process.exit(1); }
console.log(`  [t=${((Date.now()-T0)/1000).toFixed(1)}s] done`); console.log("\nALL SOUND CHECKS PASSED");
