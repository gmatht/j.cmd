import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
await bashToJS(fs, src); // warm
await bashToJS(fs, src);
console.log("done");
