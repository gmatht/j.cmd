// ─── __texture-test.mjs — texture generator transpile + run harness ─
// 1) transpiles each self-contained examples/textures/*.sh through
//    bash2js to prove they respect the sh2runtime language discipline
// 2) checks each script embeds the canonical texture-lib.sh core
// 3) runs each script under real bash and validates the PPM output
//    (magic, dimensions, byte count, determinism)
// 4) optional extra: TEX_SIZE=32 run + --preview sanity + PNG magic
//
//   node __texture-test.mjs   → "ALL TEXTURE CHECKS PASSED"
import { readFileSync, rmSync, readdirSync } from "fs";
import { execFileSync } from "node:child_process";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";

const DIR = "examples/textures";
const SCRIPTS = readdirSync(DIR)
  .filter((f) => /^texture-[a-z]+\.sh$/.test(f) && f !== "texture-lib.sh")
  .sort();
let fails = 0;
const ok = (msg) => console.log("  ok  " + msg);
const bad = (msg) => { console.log("  FAIL " + msg); fails++; };

// ─── 1) transpile checks ──────────────────────────────────────────
console.log("transpile (bash2js)…");
for (const s of SCRIPTS) {
  const src = readFileSync(`${DIR}/${s}`, "utf8");
  try {
    const { js } = await bashToJS(fs, src);
    if (js.includes("TRANSPILE FAILED")) throw new Error("runtime error marker");
    ok(`${s} → ${js.length} chars of JS`);
  } catch (e) {
    bad(`${s} transpile: ${e.message}`);
  }
}

// ─── 2) embedded-core consistency (self-contained scripts stay in
//        sync with texture-lib.sh) ─────────────────────────────────
console.log("texture-lib.sh core embedded…");
const lib = readFileSync(`${DIR}/texture-lib.sh`, "utf8");
const coreStart = lib.indexOf("# ─── pseudorandom core");
const core = lib.slice(coreStart);
const SENTINELS = ["Park–Miller", "2654435761", "73454075", "vnoise2()", "emit()", "finish()"];
for (const s of SCRIPTS) {
  const src = readFileSync(`${DIR}/${s}`, "utf8");
  const missing = SENTINELS.filter((sn) => !src.includes(sn));
  if (missing.length) bad(`${s} missing lib sentinels: ${missing.join(", ")}`);
  else ok(`${s} embeds the core (${SENTINELS.length} sentinels)`);
}

// ─── 2) run under real bash, validate PPM ─────────────────────────
console.log("run under real bash (PPM validation)…");
const expectedBytes = (size) => Buffer.byteLength(`P6\n${size} ${size}\n255\n`) + size * size * 3;
for (const s of SCRIPTS) {
  const t = s.replace("texture-", "").replace(".sh", "");
  try {
    const ppm = execFileSync("bash", [`${DIR}/${s}`], { encoding: "buffer" });
    // the MIME name textures (jpeg/png/octet/text) always generate at
    // 64×64 — the type name is drawn at a glyph scale that fills the
    // width (2-4px strokes, readable on the mime cubes); everything
    // else keeps the 16×16 default
    const size = ["jpeg", "png", "octet", "text"].includes(t) ? 64 : 16;
    const head = ppm.subarray(0, 14).toString("ascii");
    if (!head.startsWith(`P6\n${size} ${size}\n255\n`)) throw new Error(`bad header: ${JSON.stringify(head)}`);
    if (ppm.length !== expectedBytes(size)) throw new Error(`length ${ppm.length} != ${expectedBytes(size)}`);
    ok(`${t}: ${size}×${size} PPM, ${ppm.length} bytes`);
  } catch (e) {
    bad(`${t}: ${e.message}`);
  }
}

// ─── 3) determinism ───────────────────────────────────────────────
console.log("determinism (same seed → same bytes)…");
try {
  const a = execFileSync("bash", [`${DIR}/texture-stone.sh`], { encoding: "buffer" });
  const b = execFileSync("bash", [`${DIR}/texture-stone.sh`], { encoding: "buffer" });
  if (Buffer.compare(a, b) !== 0) throw new Error("bytes differ for same seed");
  ok("stone: identical output on repeat runs");
} catch (e) {
  bad(`determinism: ${e.message}`);
}
try {
  const c = execFileSync("bash", [`${DIR}/texture-stone.sh`], {
    env: { ...process.env, TEX_SEED: "999" }, encoding: "buffer",
  });
  const d = execFileSync("bash", [`${DIR}/texture-stone.sh`], {
    env: { ...process.env, TEX_SEED: "1000" }, encoding: "buffer",
  });
  if (Buffer.compare(c, d) === 0) throw new Error("different seeds produced identical bytes");
  ok("stone: different seeds → different bytes");
} catch (e) {
  bad(`seed variation: ${e.message}`);
}

// ─── 4) TEX_SIZE=32, preview, png ─────────────────────────────────
console.log("size override / preview / png…");
try {
  const big = execFileSync("bash", [`${DIR}/texture-wood.sh`], {
    env: { ...process.env, TEX_SIZE: "32" }, encoding: "buffer",
  });
  const head = big.subarray(0, 14).toString("ascii");
  if (!head.startsWith("P6\n32 32\n255\n")) throw new Error(`bad header ${JSON.stringify(head)}`);
  if (big.length !== expectedBytes(32)) throw new Error(`length ${big.length}`);
  ok("wood: TEX_SIZE=32 → 32×32 PPM");
} catch (e) {
  bad(`TEX_SIZE=32: ${e.message}`);
}
try {
  const prev = execFileSync("bash", [`${DIR}/texture-grass.sh`, "--preview"], {
    env: { ...process.env }, encoding: "utf8",
  });
  if (!prev.includes("\u001b[48;") || !/[.:=+*#%@]/.test(prev)) throw new Error("no ANSI color/shade blocks");
  if (!prev.includes("\u001b[0m")) throw new Error("no reset sequences");
  ok("grass: --preview emits ANSI color blocks");
} catch (e) {
  bad(`--preview: ${e.message}`);
}
try {
  const png = execFileSync("bash", ["texture-grass.sh", "--png"], {
    env: { ...process.env }, encoding: "buffer", cwd: `${DIR}`,
  });
  const out = readFileSync(`${DIR}/grass-20240812.png`);
  if (out.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("PNG magic missing");
  ok(`grass: --png wrote grass-20240812.png (${out.length} bytes)`);
  if (png.length > 0) bad("--png should not print binary PPM to stdout");
  else ok("grass: --png stdout stays clean");
  rmSync(`${DIR}/grass-20240812.png`);
} catch (e) {
  bad(`--png: ${e.message}`);
}

// ─── 4b) --tsv round-trip (host) ────────────────────────────────────
console.log("--tsv round-trip…");
try {
  const tsv = execFileSync("bash", [`${DIR}/texture-stone.sh`, "--tsv"], { encoding: "utf8" });
  const rows = tsv.split("\n").filter((l) => l && !l.startsWith("#texture"));
  if (rows.length !== 16) throw new Error(`expected 16 data rows, got ${rows.length}`);
  const cells = rows[0].split("\t").filter(Boolean);
  if (cells.length !== 16 * 3) throw new Error(`expected 48 numbers in row 0, got ${cells.length}`);
  const header = tsv.split("\n")[0];
  if (!header.startsWith("#texture\tstone\t16x16\tseed\t20240812\t")) throw new Error(`bad header: ${JSON.stringify(header)}`);
  ok("stone: --tsv header + 16 rows × 48 tab-separated numbers");
} catch (e) {
  bad(`--tsv: ${e.message}`);
}

// ─── 5) everything at once ────────────────────────────────────────
console.log("make-textures.sh…");
try {
  execFileSync("bash", [`${DIR}/make-textures.sh`], { stdio: "ignore" });
  for (const t of ["wood", "grass", "stone"]) {
    const png = readFileSync(`${DIR}/texture-${t}.png`);
    if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${t} PNG magic`);
  }
  const sheet = readFileSync(`${DIR}/texture-sheet.png`);
  if (sheet.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("sheet PNG magic");
  ok("make-textures.sh wrote texture-*.{ppm,png} + texture-sheet.png");
} catch (e) {
  bad(`make-textures.sh: ${e.message}`);
}

// ─── 6) jtsh copy in sync (www/examples/textures = /examples/textures) ─
console.log("www/examples/textures sync…");
const SRC_FILES = [...SCRIPTS, "texture-lib.sh", "make-textures.sh", "read-texture.sh", "README.md"];
try {
  for (const f of SRC_FILES) {
    const a = readFileSync(`${DIR}/${f}`);
    const b = readFileSync(`www/examples/textures/${f}`);
    if (!a.equals(b)) throw new Error(`${f} differs`);
  }
  ok(`all ${SRC_FILES.length} files identical in www/examples/textures/`);
} catch (e) {
  bad(`www/examples/textures sync: ${e.message}`);
}

console.log(fails === 0 ? "ALL TEXTURE CHECKS PASSED" : `${fails} TEXTURE CHECKS FAILED`);
process.exit(fails === 0 ? 0 : 1);