import { Worker } from "node:worker_threads";
const w = new Worker(`postMessage({hello: 1});`, { eval: true });
w.onmessage = (e) => console.log("onmessage works, got:", JSON.stringify(e.data));
w.on("message", (d) => console.log("on('message') works, got:", JSON.stringify(d)));
await new Promise((r) => setTimeout(r, 500));
