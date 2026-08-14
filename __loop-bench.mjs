import { createSh2Runtime } from "./src/sh2runtime.js";
const fs = {};
const shellExec = async () => ({ out: "", err: "", code: 0 });
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: { write() {} }, stderr: { write() {} }, args: [], argv0: "bash" });
const sh2 = rt.sh2;

// realistic game store: map of 768 cells, a few mimes
sh2.guard(sh2.setArray("map", Array(768).fill("2")));
sh2.setVar("mime_count", "5");
sh2.guard(sh2.setArray("mx", ["0", "1", "2", "3", "4"]));
sh2.guard(sh2.setArray("mz", ["0", "0", "0", "0", "0"]));
sh2.guard(sh2.setArray("DIR_X", ["0", "1", "0", "-1"]));
sh2.guard(sh2.setArray("DIR_Z", ["-1", "0", "1", "0"]));

let sink = 0, idx = 0;
const N = 2000;

// A) render_frame: nested whileLoop with native let counters; body does a
//    realistic get_cell (exec chain: get_cell -> map_get -> arrayIndex)
sh2.define("map_get", async () => { sh2.setVar("gv", sh2.arrayIndex("map", "$gi")); });
sh2.define("get_cell", async () => {
  sh2.setVar("a", sh2.getVar("1")); sh2.setVar("b", sh2.getVar("2")); sh2.setVar("c", sh2.getVar("3"));
  idx = (Number(sh2.getVar("b")) || 0) * 256 + (Number(sh2.getVar("c")) || 0) * 16 + (Number(sh2.getVar("a")) || 0);
  await sh2.exec("map_get", [idx]);
});
async function shapeA() {
  let rf_z = 15;
  await sh2.whileLoop(async () => rf_z >= 0, async () => {
    let rf_x = 0;
    await sh2.whileLoop(async () => rf_x < 16, async () => {
      await sh2.exec("get_cell", [rf_x, "2", rf_z]);
      await sh2.exec("get_cell", [rf_x, "1", rf_z]);
      await sh2.exec("get_cell", [rf_x, "0", rf_z]);
      sink += Number(sh2.getVar("gv"));
      rf_x = rf_x + 1;
    });
    rf_z = rf_z - 1;
  });
}

// C) proposed: native for loops; get_cell inlined as direct array reads
function shapeC() {
  const map = sh2.arrayItems("map");
  for (let rf_z = 15; rf_z >= 0; rf_z--) {
    for (let rf_x = 0; rf_x < 16; rf_x++) {
      for (let y = 0; y < 3; y++) sink += Number(map[y * 256 + rf_z * 16 + rf_x] ?? "");
    }
  }
}

// B) mime_at: store-counter whileLoop with test strings
async function shapeB() {
  sh2.setVar("ma_i", "0");
  await sh2.whileLoop(async () => sh2.test("\"$ma_i\" -lt \"$mime_count\""), async () => {
    sh2.setVar("ma_ex", sh2.arrayIndex("mx", "$ma_i"));
    sh2.setVar("ma_ez", sh2.arrayIndex("mz", "$ma_i"));
    if (await sh2.and(async () => sh2.test("\"$ma_ex\" -eq 0"), async () => sh2.test("\"$ma_ez\" -eq 0"))) sink++;
    sh2.setVar("ma_i", sh2.arithEval(() => (Number(sh2.getVar("ma_i")) || 0) + 1));
  });
}

// B2) proposed: native for + direct store reads
async function shapeB2() {
  const mx = sh2.arrayItems("mx"), mz = sh2.arrayItems("mz");
  const n = Number(sh2.getVar("mime_count"));
  for (let i = 0; i < n; i++) if (mx[i] === "0" && mz[i] === "0") sink++;
}

for (let i = 0; i < 50; i++) { await shapeA(); shapeC(); await shapeB(); await shapeB2(); }
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) await shapeA();
const tA = Number(process.hrtime.bigint() - t0) / 1e6;
const t1 = process.hrtime.bigint();
for (let i = 0; i < N; i++) shapeC();
const tC = Number(process.hrtime.bigint() - t1) / 1e6;
const t2 = process.hrtime.bigint();
for (let i = 0; i < N; i++) await shapeB();
const tB = Number(process.hrtime.bigint() - t2) / 1e6;
const t3 = process.hrtime.bigint();
for (let i = 0; i < N; i++) await shapeB2();
const tB2 = Number(process.hrtime.bigint() - t3) / 1e6;
console.log("A render loop  (current):", tA.toFixed(0), "ms   (" + (tA / N).toFixed(3) + " ms/frame)");
console.log("C render loop  (proposed):", tC.toFixed(0), "ms   (" + (tC / N).toFixed(3) + " ms/frame)  →", (tA / tC).toFixed(1) + "x");
console.log("B mime_at      (current):", tB.toFixed(0), "ms");
console.log("B2 mime_at     (proposed):", tB2.toFixed(0), "ms   →", (tB / tB2).toFixed(1) + "x");
