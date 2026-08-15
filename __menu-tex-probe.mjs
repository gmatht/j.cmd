// ─── __menu-tex-probe.mjs — menu background-texture-load probe ────
// Transpiles mimecroft.sh, forces the NON-headless path (so the
// settings menu runs), idles at the menu for 15 frames (one texture
// per menu-loop iteration), then starts + quits. Captures every
// /dev/webgl/hud write and asserts the side-slot thumbnails (HUD `I`
// images at x≈260 milli left / x≈1920 milli right) appeared DURING the
// menu, BEFORE the game started.
//
// NOTE: the current wasm mis-lowers some sync while-loops whose bodies
// call async functions (await inside a non-async arrow → SyntaxError;
// the estree worker's sync-direct-call-await regression pins). This
// probe patches those loops in the ESTree (whileLoopSync → whileLoop +
// async body) so the menu path can be exercised; the browser fix is the
// worker's.
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { estreeToJs } from "./src/estree.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

let src = readFileSync("www/bin/mimecroft.sh", "utf8");
src = src.replace("MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable", "MIMES_ON=1             # enabled for the mime tests");
src = src.replace("CRT_ON=0", "CRT_ON=1");
src = src.replace("CORRUPT_ON=0", "CORRUPT_ON=1");
// force the NON-headless path so settings_menu runs (the NullGL test
// device reports a headless state)
src = src.replace("*headless*) sound=$((0)); headless=1 ;;", "*headless*) sound=$((1)); headless=0 ;;");

let js;
try {
  const r = await bashToJS(fs, src);
  js = r.js;
  console.log("TRANSPILE OK,", js.length, "chars of JS");
  // ── probe-only wasm workaround: whileLoopSync bodies that contain an
  // await are invalid JS — flip them to the async whileLoop ──────────
  const fixed = patchAsyncLoops(r.ast);
  if (fixed > 0) console.log("patched", fixed, "sync loops with async bodies (probe workaround)");
  js = "// ── probe: regenerated after the sync-loop patch ────────────\n" + await estreeToJs(r.ast, { repl: false });
} catch (e) {
  console.log("TRANSPILE FAILED:", e.message);
  process.exit(1);
}

function containsAwait(node) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(containsAwait);
  if (node.type === "AwaitExpression") return true;
  if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return false; // don't descend into nested fns
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "range" || k === "start" || k === "end") continue;
    if (containsAwait(node[k])) return true;
  }
  return false;
}
function patchAsyncLoops(node) {
  if (!node || typeof node !== "object") return 0;
  if (Array.isArray(node)) { let n = 0; for (const c of node) n += patchAsyncLoops(c); return n; }
  let n = 0;
  if (node.type === "CallExpression" && node.callee && node.callee.type === "MemberExpression" &&
      node.callee.object && node.callee.object.type === "Identifier" && node.callee.object.name === "sh2" &&
      node.callee.property && node.callee.property.type === "Identifier" && node.callee.property.name === "whileLoopSync" &&
      node.arguments.length >= 2 && node.arguments[1].type === "ArrowFunctionExpression") {
    if (containsAwait(node.arguments[1])) {
      node.callee.property.name = "whileLoop";
      node.arguments[1].async = true;
      n++;
    }
  }
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "range" || k === "start" || k === "end") continue;
    n += patchAsyncLoops(node[k]);
  }
  return n;
}

// Menu frames: idle (one texture loads per iteration), an ArrowDown
// (redraw → the loaded thumbs re-emit), more idle, another redraw,
// then start, walk, quit. After the script ends the bridge returns
// "q," forever.
const KEY_SCRIPT = [
  "", "", "", "", "",          // 5 textures
  "ArrowDown,",                // redraw → 5 thumbs re-emit
  "", "", "", "", "",          // 10 textures
  "ArrowDown,",                // redraw → 10 thumbs re-emit
  "", "", "", "", "",          // 15 textures (14 loaded, 1 spare)
  "space,", "w,", "w,", "w,", "q,",
];
let keyFrame = 0, sleepCount = 0;
const stdout = [];
const shellExec = async (cmdline, stdin) => {
  const cl = cmdline.trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let out = "";
  if (cmd === "echo") out = rest + "\n";
  else if (cmd === "cat") {
    const p = fs._resolve(rest.split(/\s+/)[0]);
    if (p === "/dev/webgl/key") {
      const k = keyFrame < KEY_SCRIPT.length ? KEY_SCRIPT[keyFrame] : "q,";
      keyFrame++;
      out = k + "\n";
    } else { try { out = await fs.read(p); } catch (e) { out = ""; } }
  }
  else if (cmd === "sleep") {
    sleepCount++;
    if (sleepCount > 4000) throw new Error("test-stop");
    await new Promise((r) => setTimeout(r, 0));
  }
  else if (cmd === "bash") {
    const args = rest.split(/\s+/).map((a) => a.replace("/examples/", "examples/"));
    try { out = execFileSync("bash", args, { encoding: "utf8" }); } catch (e) { out = ""; }
  }
  else if (cmd === "true") {}
  else out = `${cmd}: command not found\n`;
  return { out, err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const err = { write: (s) => stdout.push("[err] " + s) };
{
  const ow = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s, ...rest) => { stdout.push(String(s)); return ow(s, ...rest); };
}

// capture every /dev/webgl/hud write (the menu text + the thumbs)
const hudWrites = [];
const origWrite = fs.write.bind(fs);
fs.write = async (p, c) => {
  if (String(p).startsWith("/dev/webgl/hud")) hudWrites.push(String(c));
  return origWrite(p, c);
};

const rt = createSh2Runtime({ fs, env: { HOME: "/home", USER: "tinysh" }, shellExec, stdout: out, stderr: err, args: [], argv0: "bash" });

// capture the hud writes at the runtime boundary (the wasm lowers the
// echo-redirects to sh2.fs.writeFile)
const origWF = rt.sh2.fs.writeFile.bind(rt.sh2.fs);
rt.sh2.fs.writeFile = async (p, data) => {
  if (String(p).startsWith("/dev/webgl/hud")) hudWrites.push(String(data));
  return origWF(p, data);
};

const origSh2ReadFile = rt.sh2.fs.readFile.bind(rt.sh2.fs);
rt.sh2.fs.readFile = async (p, enc) => {
  if (String(p) === "/dev/webgl/key") {
    const k = keyFrame < KEY_SCRIPT.length ? KEY_SCRIPT[keyFrame] : "q,";
    keyFrame++;
    return k;
  }
  return origSh2ReadFile(p, enc);
};

const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2",
  "return (async () => { " + js + " })();");
try {
  await fn([], fs, { HOME: "/home" }, out, err, shellExec, rt.sh2);
} catch (e) {
  if (e.message !== "test-stop") { console.log("RUN ERROR:", e.message); process.exit(1); }
}

console.log("RAN OK (stopped by test-stop after", sleepCount, "sleeps)");

// ─── assertions ───────────────────────────────────────────────────
let fails = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log("PASS: " + name);
  else { fails++; console.log("FAIL: " + name + (extra ? "\n  " + extra : "")); }
};

// the menu-phase hud writes: the draw_settings_menu card (starts with
// the C clear) followed by one write per texture with the I thumb


// the menu card renders as a C-clear + glyph RECTS (the pixel font);
// the thumb writes carry the `I ` HUD-image lines
// the menu card's rects must carry COLOURS now (the direct-call
// positional wrapper) — the device skips <7-number rect lines
const coloredRects = hudWrites.some((w) => /-?0\.\d+ -?0\.\d+ 0\.\d{3} 0\.\d{3} [01]\.\d{2,3}/.test(String(w)));
check("menu/game rects carry colours (positional wrapper)", coloredRects, JSON.stringify(String(hudWrites[0]).slice(0, 120)));
const menuWrites = hudWrites.filter((w) => String(w).includes("I "));
const menuTextWrites = hudWrites.filter((w) => String(w).startsWith("C\n") && String(w).split("\n").length > 500);
check("settings menu drawn on the HUD (C-clear + glyph rects)", menuTextWrites.length > 0);
check("texture thumbs written during the menu", menuWrites.length >= 14,
  `got ${menuWrites.length} hud writes containing "I " lines`);
// side columns: left slots at x≈260 milli (NDC -0.740), right at
// x≈1920 milli (NDC 0.920); top row at y≈1610 milli (NDC 0.610)
const leftThumbs = menuWrites.filter((w) => w.includes(" -0.740 ")).length;
const rightThumbs = menuWrites.filter((w) => w.includes(" 0.920 ")).length;
check("left-column thumbs (x≈260 milli)", leftThumbs >= 7, `saw ${leftThumbs}`);
check("right-column thumbs (x≈1920 milli)", rightThumbs >= 7, `saw ${rightThumbs}`);
check("top-row thumbs (y≈1610 milli)", menuWrites.some((w) => w.includes(" 0.610 ")));
// the thumbs appear BEFORE the game starts (the first I write comes
// from the menu phase, not the post-menu loading grid)
const firstThumb = hudWrites.findIndex((w) => w.includes("I "));
check("thumbs appear before the game's loading grid", firstThumb >= 0 && firstThumb < menuTextWrites.length * 2);
// the menu stayed interactive: the redraw re-emits the loaded thumbs
// (multiple writes with growing I counts)
const counts = hudWrites.filter((w) => String(w).includes("I ")).map((w) => (String(w).match(/I /g) || []).length);
check("thumbs accumulate across writes", counts.length > 1 && counts[counts.length - 1] >= counts[0]);
check("menu redraw re-emits the loaded thumbs", counts.some((c) => c >= 5), `counts: ${JSON.stringify(counts.slice(0, 20))}`);
console.log("thumb counts per write:", JSON.stringify(counts.slice(0, 20)));

const log = await fs.read("/dev/webgl/log");
check("shaders compiled (vertex+fragment)", log.includes("[shader/vertex]") && log.includes("[shader/fragment]"), log.split("\n").slice(-6).join("\n"));
check("program linked", log.includes("[program] linked OK"));

console.log(fails === 0 ? "ALL MENU-TEX CHECKS PASSED" : `${fails} CHECKS FAILED`);
process.exit(fails === 0 ? 0 : 1);
