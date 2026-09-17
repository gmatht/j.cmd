import { Worker } from "node:worker_threads";
// module-mode worker using parentPort, posting ready
const w = new Worker(`
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ ready: true });
parentPort.on("message", (d) => parentPort.postMessage({ echo: d }));
`, { eval: true, type: "module" });
let got = [];
w.onmessage = (e) => { got.push(e.data); console.log("onmessage got:", JSON.stringify(e.data)); };
w.on("message", (d) => console.log("on('message') got:", JSON.stringify(d)));
w.postMessage({ ping: 1 });
await new Promise((r) => setTimeout(r, 500));
console.log("total onmessage:", got.length);
