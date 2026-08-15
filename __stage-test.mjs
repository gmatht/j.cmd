import { readFileSync, writeFileSync } from "fs";
const lib = readFileSync("www/examples/sounds/sound-lib.sh", "utf8");
const ss = readFileSync("www/examples/sounds/sound-shoot.sh", "utf8");
const ss_pre = ss.split("sl_dir=")[0];
let ss_post = ss.split("sound-lib.sh").pop();
if (ss_post.startsWith('"')) ss_post = ss_post.slice(1);
writeFileSync("www/examples/sounds/__staged.sh", lib + ss_pre + ss_post);
console.log("staged OK, lib=" + lib.length + " pre=" + ss_pre.length + " post=" + ss_post.length);
