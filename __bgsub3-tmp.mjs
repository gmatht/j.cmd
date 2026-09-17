import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { ensureBgWorker } from "./src/bgworker.js";
// instrument: watch the worker's messages
const { Worker } = await import("node:worker_threads");
const src = (await import("./src/bgworker.js"));
// patch the worker's onmessage to log
const w = await ensureBgWorker();
console.log("worker object type:", typeof w);
// check module exports for debugging hooks
console.log("exports:", Object.keys(src));
// manual probe: post a test message and see if anything comes back
const worker = w;
const t0 = Date.now();
let got = null;
const orig = worker.onmessage;
worker.onmessage = (e) => { console.log("MAIN got message:", JSON.stringify(e.data).slice(0, 120), "after", Date.now() - t0, "ms"); if (orig) orig(e); };
// submit via the direct API with a 10s timeout
const { id, promise } = await src.bgSubmit("echo hello-bg", []);
const r = await Promise.race([promise.then(() => "resolved"), new Promise((res) => setTimeout(() => res("TIMEOUT after 10s"), 10000))]);
console.log("result:", r);
