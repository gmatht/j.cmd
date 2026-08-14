// Headless test of the doubly linked list (www/examples/c/
// doubly_linked_list.c): the C walks BOTH directions (prev + next),
// and the ptrfs walks the cyclic pointer graph safely — the prev
// back-edges are shown as directories but never re-walked (visited
// guard), so find/grep terminate.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { ensureBusyboxWasm, busyboxA1, BUSYBOX_VERSION } from "./src/busybox.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
import { estreeToJs, keepVariables } from "./src/estree.js";
import { GoRunner } from "./src/go.js";
import { createShellCore } from "./src/shellcore/index.js";

const goRunner = new GoRunner(fs, { baseUrl: "www/" });
const { readFile } = await import("node:fs/promises");
const bytes = new Uint8Array(await readFile("www/wasm-bin/otranspiler-busybox.wasm"));
await fs.writeBlob("/usr/bin/otranspiler-busybox.wasm", new Blob([bytes]));
await fs.write("/usr/bin/otranspiler-busybox.wasm.ver", BUSYBOX_VERSION);

const a1 = await busyboxA1(readFileSync("www/examples/c/doubly_linked_list.c", "utf8"), "c", { fs, wasmPath: "/usr/bin/otranspiler-busybox.wasm", goRunner });
const lib = await getOtranspilerl();
const program = JSON.parse(lib.render(JSON.stringify(a1), "js"));
keepVariables(program, []);
const js = await estreeToJs(program);

const stdout = { _buf: "", write(s) { this._buf += s; } };
const stderr = { _buf: "", write(s) { this._buf += s; } };
const rt = createSh2Runtime({ fs, env: {}, shellExec: async () => ({ out: "", err: "", code: 0 }), stdout, stderr, argv0: "bash" });
const proc = { stdout, stderr, env: {}, argv: [], cwd: () => "/" };
await new Function("fs", "env", "process", "sh2", "return (async () => { " + js + " })();")(fs, {}, proc, rt.sh2);

let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log("PASS: " + name);
  else { fails++; console.log("FAIL: " + name + (extra ? " — " + extra : "")); }
};

// 1. the sourced demo ran at source time (the main built one/two/three
// and printed both directions)
const demo = stdout._buf;
check("demo printed fwd + rev", /fwd:  one two three /.test(demo) && /rev:  three two one /.test(demo), JSON.stringify(demo.slice(0, 200)));

// 2. the C functions walk both directions (fresh list: append after the demo's)
stdout._buf = "";
await rt.sh2.fnCall("add", ["four"]);
await rt.sh2.fnCall("add", ["five"]);
await rt.sh2.fnCall("print_fwd", []);
check("print_fwd includes the new tail", stdout._buf.includes("one two three four five"), JSON.stringify(stdout._buf));
stdout._buf = "";
await rt.sh2.fnCall("print_rev", []);
check("print_rev reverses via prev", stdout._buf.includes("five four three two one"), JSON.stringify(stdout._buf));

// 3. the ptrfs over the cyclic pointer graph
const head = rt.sh2.getVar("head");
check("head is a live pointer", /^\u0001mem:\d+:0$/.test(String(head)), String(head));

const out = { _buf: "", write(s) { this._buf += s; } };
const err = { _buf: "", write(s) { this._buf += s; } };
let bound = null;
const ctx = {
  get otRt() { return rt; },
  stdout: out, stderr: err,
  runNestedCommand: async (cmdline) => {
    const parts = cmdline.trim().split(/\s+/);
    const [cmd, ...a] = parts;
    if (bound && bound[cmd]) {
      const cap = { _buf: "", write(s) { this._buf += s; } };
      const prevOut = ctx.stdout;
      ctx.stdout = cap;
      try { const code = await bound[cmd](a); return { out: cap._buf, err: "", code }; }
      finally { ctx.stdout = prevOut; }
    }
    return { out: "", err: "", code: 127 };
  },
};
const { builtins } = createShellCore(ctx);
bound = builtins;
const run = async (name, args) => {
  out._buf = ""; err._buf = "";
  const code = await builtins[name](args);
  return { code, out: out._buf, err: err._buf };
};

let r = await run("cd", [String(head)]);
check("cd into the head", r.code === 0, r.err);
r = await run("ls", []);
check("ls shows word + next/ (head.prev is NULL)", r.out.includes("word") && r.out.includes("next/") && !r.out.includes("prev/"), JSON.stringify(r.out));
r = await run("cat", ["word"]);
check("cat word = one", r.out.trim() === "one", JSON.stringify(r.out));

// the prev back-edge of node two points back to the head — find must
// show it as a directory but NOT re-walk it (visited guard)
r = await run("find", ["."]);
check("find walks next, shows prev back-edge, skips its contents",
  r.out.includes("./next/prev/") && !r.out.includes("./next/prev/word"), JSON.stringify(r.out));
check("find reaches the tail node's word", r.out.includes("./next/next/next/next/word"), JSON.stringify(r.out));
check("find terminates (deepest prev back-edge not re-walked)", !r.out.includes("./next/next/next/next/prev/word"), JSON.stringify(r.out));

// grep over the cyclic graph terminates
r = await run("grep", ["three", "."]);
check("grep finds three via next chain", r.out.includes("three"), JSON.stringify(r.out));

// navigate prev at the tail — the back-edge is a real directory
r = await run("cd", ["next/next"]);
r = await run("cd", ["prev"]);
r = await run("pwd", []);
check("cd next/next/prev reaches node two", r.out.trim() === String(head) + "/next/next/prev", JSON.stringify(r.out));
r = await run("cat", ["word"]);
check("cat word there = two", r.out.trim() === "two", JSON.stringify(r.out));

// leave pointer mode
r = await run("cd", ["/"]);
check("cd / leaves pointer mode", r.code === 0, r.err);
check("ptrCwd cleared", !ctx.ptrCwd);

// tab completion of sourced functions — the same filter the shell's
// command completer applies to the runtime function table
const fns = [...rt.sh2.functions.keys()];
check("completion: print_f → print_fwd", fns.includes("print_fwd") && fns.filter((n) => n.startsWith("print_f")).includes("print_fwd"), JSON.stringify(fns));
check("completion: add + print_rev listed", fns.includes("add") && fns.includes("print_rev"), JSON.stringify(fns));
check("completion: no builtin shadow (print_fwd not a builtin)", !Object.keys(builtins).includes("print_fwd"));

process.exit(fails ? 1 : 0);
