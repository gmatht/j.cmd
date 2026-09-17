// syntax/semantics check: transpile the game and verify the new funcs exist
import { readFileSync } from "node:fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const { js } = await bashToJS(fs, src);
for (const fn of ["load_tex_payload", "tex_bg_submit", "tex_bg_done", "tex_bg_harvest", "tex_bg_jobs"]) {
  console.log(fn, "emitted:", js.includes(fn));
}
