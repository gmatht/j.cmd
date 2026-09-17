import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
// build the exact worker source from bgworker and log everything
const src = readFileSync("src/bgworker.js", "utf8");
const m = await import("./src/bgworker.js");
// replicate: create the worker like bgworker does, with logging
const { Worker } = await import("node:worker_threads");
const base = new URL(".", import.meta.url).href;
// instead of importing bgworker internals, spawn via a direct copy of workerSource
const workerSrc = (() => {
  // monkeypatch: import the module and steal its workerSource via eval? simpler: reconstruct
  return null;
})();
// simplest: just check whether worker.onmessage works in Node
const w = new Worker(`postMessage({hello: 1});`, { eval: true });
w.onmessage = (e) => console.log("onmessage works, got:", JSON.stringify(e.data));
w.on("message", (d) => console.log("on('message') works, got:", JSON.stringify(d)));
await new Promise((r) => setTimeout(r, 500));
