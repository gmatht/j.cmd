import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
import * as lowerMod from "./src/lower.js";
import * as estreeMod from "./src/estree.js";
const lib = await getOtranspilerl();
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const program = JSON.parse(lib.transpile(src, "sh", "js"));
const t = (label) => { const now = performance.now(); return (prev) => { const d = now - (prev === undefined ? now : prev); return now; }; };
// instrument: replicate the pass sequence with timings
const { lowerNativeArrays, hoistLoopLastExit, hoistCommonLastExit, dropDeadFlags, pushLastExitToEnd, mergeInitAssignments, nativeForLoops, lowerPureFunctions, flattenAndOrAll, lowerDeviceRedirects, directShellFnCalls } = lowerMod;
const { normalizeFunctions, awaitAsyncDirectCalls, markAsyncOnAwait, forceAsyncFileRedirects, awaitSyncFnCalls, stripProcessEnv, unwrapStoreString, nullSentinel, returnInLoop, keepVariables, writeBuiltinOutput, reclassAsyncLoops } = estreeMod;
const times = [];
const time = async (label, fn) => { const t0 = performance.now(); const r = await fn(); times.push([label, performance.now() - t0]); return r; };
for (let iter = 0; iter < 3; iter++) {
  let normalized = program;
  normalized = await time("strip+awaitSync+mark+awaitAsync+normalize", async () =>
    normalizeFunctions(awaitAsyncDirectCalls(markAsyncOnAwait(forceAsyncFileRedirects(awaitSyncFnCalls(stripProcessEnv(program), false))))));
  normalized = await time("unwrapStoreString", () => unwrapStoreString(normalized));
  normalized = await time("nullSentinel", () => nullSentinel(normalized));
  normalized = await time("returnInLoop", () => returnInLoop(normalized, false));
  normalized = await time("directShellFnCalls", () => directShellFnCalls(normalized));
  normalized = await time("reclassAsyncLoops", () => reclassAsyncLoops(normalized));
  await time("keepVariables", () => keepVariables(normalized, [], { repl: false }));
  normalized = await time("lowerNativeArrays", () => lowerNativeArrays(normalized));
  normalized = await time("hoistLoopLastExit", () => hoistLoopLastExit(normalized));
  normalized = await time("hoistCommonLastExit", () => hoistCommonLastExit(normalized));
  normalized = await time("dropDeadFlags", () => dropDeadFlags(normalized));
  normalized = await time("pushLastExitToEnd", () => pushLastExitToEnd(normalized));
  normalized = await time("mergeInitAssignments", () => mergeInitAssignments(normalized));
  if (typeof nativeForLoops === "function") normalized = await time("nativeForLoops", () => nativeForLoops(normalized));
  if (typeof flattenAndOrAll === "function") normalized = await time("flattenAndOrAll", () => flattenAndOrAll(normalized));
  if (typeof lowerDeviceRedirects === "function") normalized = await time("lowerDeviceRedirects", () => lowerDeviceRedirects(normalized));
  await time("lowerPureFunctions", () => lowerPureFunctions(normalized));
  await time("writeBuiltinOutput", () => writeBuiltinOutput(normalized));
  if (iter === 0) times.length = 0; // warm
}
const byName = new Map();
for (const [l, d] of times) byName.set(l, (byName.get(l) || 0) + d);
const total = [...byName.values()].reduce((a, b) => a + b, 0);
console.log("per-pass wall time (median of 2, ms):");
for (const [l, d] of [...byName.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${(100 * d / total).toFixed(1).padStart(5)}%  ${d.toFixed(0).padStart(6)}  ${l}`);
}
console.log(`  total passes: ${total.toFixed(0)} ms`);
