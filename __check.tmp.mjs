import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
const src = readFileSync("/home/llm/sh2loop/sh2perl/examples/sync-direct-call-await.sh", "utf8");
const { js } = await bashToJS(fs, src);
console.log(js);
