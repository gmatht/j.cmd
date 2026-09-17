import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bgSubmit, bgPeek, ensureBgWorker, bgStatus } from "./src/bgworker.js";
const scriptText = readFileSync("www/examples/textures/texture-dirt.sh", "utf8");
// wait for the worker to be truly ready first
await new Promise((r) => setTimeout(r, 3000));
const t0 = Date.now();
const { id, promise } = await bgSubmit(scriptText, ["--tsv", "--size", "32", "--seed", "20240812"]);
console.log("bgSubmit:", Date.now() - t0, "ms");
const r = await Promise.race([promise.then(() => "resolved"), new Promise((res) => setTimeout(() => res("TIMEOUT"), 60000))]);
console.log("promise:", r);
console.log("status:", bgStatus().trim());
