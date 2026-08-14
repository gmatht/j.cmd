// Headless test of the generic walker (www/examples/c/generic_walk.c):
// the walker uses nodeChild/nodeData (the layout registry) — it knows
// NO layout, yet counts/finds over the Node list that linked_list.c
// builds. Also checks ptrTag (the box's Tag-<hash> key) and that the
// registry survives both files sourcing into one runtime (both declare
// `struct Node` — the same tag, the same layout).
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { ensureBusyboxWasm, busyboxA1, BUSYBOX_VERSION } from "./src/busybox.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
import { estreeToJs, keepVariables } from "./src/estree.js";
import { GoRunner } from "./src/go.js";

const goRunner = new GoRunner(fs, { baseUrl: "www/" });
const { readFile } = await import("node:fs/promises");
const bytes = new Uint8Array(await readFile("www/wasm-bin/otranspiler-busybox.wasm"));
await fs.writeBlob("/usr/bin/otranspiler-busybox.wasm", new Blob([bytes]));
await fs.write("/usr/bin/otranspiler-busybox.wasm.ver", BUSYBOX_VERSION);

const build = async (file) => {
  const a1 = await busyboxA1(readFileSync(file, "utf8"), "c", { fs, wasmPath: "/usr/bin/otranspiler-busybox.wasm", goRunner });
  const lib = await getOtranspilerl();
  const program = JSON.parse(lib.render(JSON.stringify(a1), "js"));
  keepVariables(program, []);
  return estreeToJs(program);
};
const genJs = await build("www/examples/c/linked_list.c");
const walkJs = await build("www/examples/c/generic_walk.c");

const stdout = { _buf: "", write(s) { this._buf += s; } };
const stderr = { _buf: "", write(s) { this._buf += s; } };
const rt = createSh2Runtime({ fs, env: {}, shellExec: async () => ({ out: "", err: "", code: 0 }), stdout, stderr, argv0: "bash" });
const proc = { stdout, stderr, env: {}, argv: [], cwd: () => "/" };
const fn = new Function("fs", "env", "process", "sh2", "return (async () => { " + genJs + " })();");
await fn(fs, {}, proc, rt.sh2);

// build a list via slurp2 (the linked_list.c main only slurps+sinks —
// $last is set by the slurp2 function itself)
rt.sh2.stdin = "three\ntwo\none\n";
await rt.sh2.fnCall("slurp2", []);

let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log("PASS: " + name);
  else { fails++; console.log("FAIL: " + name + (extra ? " — " + extra : "")); }
};

// the list is built; grab the head (the slurp2 equivalent — the $last global)
const head = rt.sh2.getVar("last");
check("head is a live pointer", /^\u0001mem:\d+:0$/.test(String(head)) || (head && typeof head === "object"), JSON.stringify(head));

// registerStruct ran (the runtime layout registry has the Node layout)
check("registerStruct registered Node", rt.sh2.ptrTag(head) === "Tag-3468032d", "got " + JSON.stringify(rt.sh2.ptrTag(head)));

// generic walk over the boxed list — nodeChild follows the next chain
const wfn = new Function("fs", "env", "process", "sh2", "return (async () => { " + walkJs + " })();");
rt.sh2.setVar("last", head);
await wfn(fs, {}, proc, rt.sh2);

const count = await rt.sh2.fnCall("generic_count", [head]);
check("generic_count walks 3 nodes", Number(count) === 3, "got " + count);

stdout._buf = "";
const found = await rt.sh2.fnCall("generic_find", [head, "three"]);
check("generic_find walks to 'three' at index 2", /found three at 2/.test(stdout._buf), JSON.stringify(stdout._buf));
check("generic_find returns 0 (found)", Number(found) === 0, "got " + found);

// a tree-style walk: nodeChild on a DIFFERENT member index reads the word
stdout._buf = "";
const w0 = rt.sh2.nodeData(head, 0);
check("nodeData(p,0) reads the word member", w0 === "one", JSON.stringify(w0));
const next = rt.sh2.nodeChild(head, 1);
check("nodeChild(p,1) follows next", next && typeof next === "object", "not a box");

process.exit(fails ? 1 : 0);
