import { readFileSync, writeFileSync } from "fs";
import { getOtranspilerl } from "../src/otranspilerl.js";
const lib = await getOtranspilerl();
const src = readFileSync("www/bin/mimecroft.sh", "utf8");
const program = JSON.parse(lib.compile(src)).estree;
// run with OLD mergeInitAssignments
{
  const lowerSrc = readFileSync("/tmp/lower-with-old-merge.js", "utf8");
  writeFileSync("/tmp/lower-mod.cjs", lowerSrc);
  // can't swap modules dynamically easily — instead patch lower.js, run, restore
}
