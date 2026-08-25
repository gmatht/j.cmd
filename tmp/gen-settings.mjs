import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
let src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
const i = js.indexOf("settings_menu");
console.log("=== settings_menu generated code ===");
console.log(js.slice(i - 200, i + 3000));
