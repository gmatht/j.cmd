// ─── __sideblocks-test.mjs — the blocks immediately left/right of the
// player stay visible (regression test).
//
// Two bugs are covered:
//   1. try_draw/banner_visible tested "in front" against the player's
//      ROUNDED cell (dpx/dpz). During a move glide the rounded cell
//      flips to the destination at the HALFWAY point, so the row the
//      camera is still approaching (with the blocks visible at the
//      left/right of the view) was culled a full half-cell before the
//      player arrived. The fix compares against the FRACTIONAL camera
//      position (dpcx_ms/dpcz_ms).
//   2. The in-front test compared the block CENTRE depth (w) against 0.
//      A block immediately left/right of the player has centre w = 0
//      (on the camera plane) even though its front face is half a cell
//      IN FRONT — the projection draws that face (its near edge is on
//      screen), so culling on the centre made the corridor walls beside
//      the player vanish whenever the camera sat exactly on the cell
//      row (standing still, or the moment a move arrives). The fix
//      tests the NEAR face: w + 500·(|cs|+|sn|)/1000.
//
// This test extracts the REAL try_draw + banner_visible function bodies
// (header included) out of www/bin/mimecroft.sh, drives them through
// the project's bash→JS runtime with a synthetic map, and asserts:
//   • standing at (8,8) facing -z → (7,7)/(9,7) drawn AND the same-row
//     (7,8)/(9,8) drawn (the projection shows their front faces);
//   • a cell 2 to the side on the same row stays culled (off-screen);
//   • 60% through the move to (8,7) (dpcz_ms=7400, rounded dpz=7) →
//     (7,7)/(9,7) STILL drawn (bug 1: they vanished mid-glide);
//   • arrived at (8,7) (dpcz_ms=7000) → (7,7)/(9,7) still drawn (they
//     are now beside the player — bug 2) and (7,8) culled (behind);
//   • yaw 1 (facing +x) mirror cases;
//   • banner_visible on a side cell mid-move → visible.
import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { runBash } from "./src/bash2js.js";

const src = readFileSync("www/bin/mimecroft.sh", "utf8");

// pull a named multi-line function body out of the game (the header
// line through the first line that is exactly "}")
const extractFn = (name) => {
  const start = src.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = src.indexOf("\n}\n", start) + 2; // include the closing "}"
  return src.slice(start, end);
};

// the per-degree cos/sin tables (‰) the continuous frustum uses
const extractArray = (name) => {
  const start = src.indexOf(`${name}=(`);
  if (start < 0) throw new Error(`array ${name} not found`);
  const end = src.indexOf(")", start) + 1;
  return src.slice(start, end) + "\n";
};
const SCOS_SRC = extractArray("SCOS");
const SSIN_SRC = extractArray("SSIN");

const testSrc = `
AIR=0
STONE=1
VIEW_R=16
RD_VR=$((VIEW_R * 1000))
rd_cs=1000
rd_sn=0
crouched=0
CELLS=256
MAP_W=16

# the inlined try_draw reads the map/mime/bhp ARRAYS directly (the
# render hot-path refactor removed the get_cell/mime_at/draw_block
# fnCall dispatches) — pre-fill the store: everything AIR except the
# listed y=1 blocks. y=2 stays AIR so the banner line-of-sight passes.
map=()
mi=0
while [ "$mi" -lt 768 ]; do
  map[$mi]=$AIR
  mi=$((mi + 1))
done
# cell → mime index (the real game inits every slot to -1; an UNSET
# slot would read as "" → bash -ge coerces it to 0 → phantom mime)
mime_lookup=()
mi=0
while [ "$mi" -lt 256 ]; do
  mime_lookup[$mi]=-1
  mi=$((mi + 1))
done
# y=1 blocks: (7,7) (9,7) (9,9) (7,8) (9,8) (6,8) (8,6) (8,7) — index = 256 + z*16 + x
map[375]=$STONE   # 1,7,7
map[377]=$STONE   # 1,9,7
map[409]=$STONE   # 1,9,9
map[391]=$STONE   # 1,7,8
map[393]=$STONE   # 1,9,8
map[390]=$STONE   # 1,6,8
map[360]=$STONE   # 1,8,6
map[376]=$STONE   # 1,8,7

# the per-degree cos/sin tables (‰) — the continuous frustum
${SCOS_SRC}
${SSIN_SRC}

# the hoisted rotation — the game's compute_display refreshes rd_cs/
# rd_sn once per frame from dpyw_ms; the test drives try_draw directly,
# so each scenario derives them the same way
setcam() { sc_x=$1; sc_z=$2; sc_cx=$3; sc_cz=$4; sc_y=$5
  dpx=$sc_x; dpz=$sc_z; dpcx_ms=$sc_cx; dpcz_ms=$sc_cz; dpyw_ms=$sc_y
  rd_deg=$((dpyw_ms / 1000))
  rd_cs=\${SCOS[$rd_deg]}
  rd_sn=\${SSIN[$rd_deg]}
}

# banner_visible still calls these two helpers
get_cell() { g_a=$1; g_b=$2; g_c=$3; gv=$AIR; gi=$((g_b * CELLS + g_c * MAP_W + g_a)); gv=\${map[$gi]}; }
abs() { ab_v=$1; if [ "$ab_v" -lt 0 ]; then ab_v=$((0 - ab_v)); fi; av=$ab_v; }

${extractFn("try_draw")}

${extractFn("banner_visible")}

try_one() { blk_p=""; try_draw $1 1 $2; if [ -n "$blk_p" ]; then res=DRAWN; else res=hidden; fi; }

fails=0
check() { if [ "$3" = "$2" ]; then echo "PASS: $1"; else echo "FAIL: $1 (want $2, got $3)"; fails=$((fails + 1)); fi; }

# ── yaw 0 (facing -z): standing at (8,8)
setcam 8 8 8000 8000 0
try_one 7 7; check "stand: left-ahead (7,7)" DRAWN "$res"
try_one 9 7; check "stand: right-ahead (9,7)" DRAWN "$res"
try_one 8 7; check "stand: straight-ahead (8,7)" DRAWN "$res"
try_one 7 8; check "stand: same-row left (7,8) DRAWN (near face in front)" DRAWN "$res"
try_one 9 8; check "stand: same-row right (9,8) DRAWN (near face in front)" DRAWN "$res"
try_one 6 8; check "stand: 2-left same row (6,8) culled (off-screen cone)" hidden "$res"
banner_visible 7 7; check "stand: banner at (7,7)" 1 "$bv"

# ── yaw 0: 60% through the move (8,8)→(8,7): camera at z=7.4, so the
# ROUNDED cell is already 7 — the old code culled the whole row here
setcam 8 7 8000 7400 0
try_one 7 7; check "midmove: left-ahead (7,7) STAYS" DRAWN "$res"
try_one 9 7; check "midmove: right-ahead (9,7) STAYS" DRAWN "$res"
try_one 8 7; check "midmove: straight-ahead (8,7)" DRAWN "$res"
try_one 8 6; check "midmove: row beyond (8,6)" DRAWN "$res"
try_one 7 8; check "midmove: row behind (7,8) culled" hidden "$res"
banner_visible 7 7; check "midmove: banner at (7,7) STAYS" 1 "$bv"

# ── yaw 0: arrived at (8,7) — the side blocks are now BESIDE the player
# (centre w=0) yet still visible (near face half a cell in front)
setcam 8 7 8000 7000 0
try_one 7 7; check "arrived: left beside (7,7) DRAWN (near face)" DRAWN "$res"
try_one 9 7; check "arrived: right beside (9,7) DRAWN (near face)" DRAWN "$res"
try_one 8 6; check "arrived: row ahead (8,6)" DRAWN "$res"
try_one 7 8; check "arrived: row behind (7,8) culled" hidden "$res"

# ── yaw 1 (facing +x): moving (8,8)→(9,8), 60% in (x=8.6, rounded 9)
setcam 9 8 8600 8000 90000
try_one 9 7; check "yaw1 midmove: right-ahead (9,7) STAYS" DRAWN "$res"
try_one 9 9; check "yaw1 midmove: right-ahead (9,9) STAYS" DRAWN "$res"
try_one 8 7; check "yaw1 midmove: row behind (8,7) culled" hidden "$res"

# ── 45° turn (the regression): half-way through a right turn
# (yaw 0→1, dpyw_ms=45000) the camera faces NE — the OLD discrete-yaw
# culling had already flipped to the +x axis, so the left half of the
# view (cells at x = dpx, z < dpz) was culled and the world looked
# empty. The continuous frustum keeps both sides of the 45° view.
setcam 8 8 8000 8000 45000
try_one 9 8; check "turn45: right side (9,8) DRAWN" DRAWN "$res"
try_one 8 7; check "turn45: left-front (8,7) DRAWN" DRAWN "$res"
try_one 7 8; check "turn45: behind-left (7,8) culled" hidden "$res"
try_one 8 8; check "turn45: own cell culled" hidden "$res"
banner_visible 8 7; check "turn45: banner at (8,7) STAYS" 1 "$bv"

if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "FAILURES: $fails"; exit 1; fi
`;

let fails = 0;
const out = { write: (s) => { process.stdout.write(s); if (s.includes("FAIL")) fails++; } };
try {
  await runBash(fs, testSrc, { stdout: out, stderr: { write: (s) => process.stdout.write("[err] " + s) }, runCmd: async () => ({ out: "", err: "", code: 0 }), args: [], argv0: "bash" });
} catch (e) {
  console.log("RUN ERROR:", e.message);
  process.exit(1);
}
if (fails > 0) process.exit(1);
console.log("__sideblocks-test.mjs OK");
