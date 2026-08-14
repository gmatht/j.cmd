// Isolate the sh2 dispatch overhead of `$(cat /dev/webgl/key)`:
//   A) capture → exec("cat") → shellExec (no fs involved — pure plumbing)
//   B) the floor: a bare async call returning the same string
import { createSh2Runtime } from "./src/sh2runtime.js";
const shellExec = async () => ({ out: "w,w,ArrowRight,q,\n", err: "", code: 0 });
const rt = createSh2Runtime({ fs: {}, env: {}, shellExec, stdout: { write() {} }, stderr: { write() {} }, args: [], argv0: "bash" });
const sh2 = rt.sh2;
const N = 200000;
let sink = 0;
for (let i = 0; i < 2000; i++) { sink += (await sh2.capture(async () => await sh2.exec("cat", ["/dev/webgl/key"]))).length; }
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) sink += (await sh2.capture(async () => await sh2.exec("cat", ["/dev/webgl/key"]))).length;
const tA = Number(process.hrtime.bigint() - t0) / 1e6;
const readKey = async () => "w,w,ArrowRight,q,\n";
const t1 = process.hrtime.bigint();
for (let i = 0; i < N; i++) sink += (await readKey()).length;
const tB = Number(process.hrtime.bigint() - t1) / 1e6;
console.log("A capture+exec dispatch:", (tA / N * 1000).toFixed(2), "us/call  (" + tA.toFixed(0) + " ms)");
console.log("B bare async read      :", (tB / N * 1000).toFixed(2), "us/call  (" + tB.toFixed(0) + " ms)");
console.log("dispatch overhead      :", ((tA - tB) / N * 1000).toFixed(2), "us/call  →", (tA / tB).toFixed(0) + "x   (sink=" + sink + ")");
