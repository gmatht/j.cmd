import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bgSubmit, bgPeek } from "./src/bgworker.js";
const stone = readFileSync("www/examples/textures/texture-stone.sh", "utf8");
const dirt = readFileSync("www/examples/textures/texture-dirt.sh", "utf8");
// warm (first submit loads the worker + wasm)
const w0 = Date.now();
await (await bgSubmit("echo warm", [])).promise;
console.log("warm submit:", Date.now() - w0, "ms");
// two concurrent submits
const t0 = Date.now();
const a = await bgSubmit(stone, ["--tsv", "--size", "32", "--seed", "20240812"]);
const b = await bgSubmit(dirt, ["--tsv", "--size", "32", "--seed", "20240812"]);
console.log("two submits returned:", Date.now() - t0, "ms (non-blocking)");
await Promise.all([a.promise, b.promise]);
console.log("both done at:", Date.now() - t0, "ms (parallel ≈ max single time, not sum)");
console.log("a:", bgPeek(a.id).out.length, "b:", bgPeek(b.id).out.length, "bytes");
