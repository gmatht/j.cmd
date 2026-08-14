// Headless test of the ptrfs: `cd $ptr` + `find .` / `ls` over a
// sourced C linked list. The pointer is a tiny filesystem — the layout
// registry's members are its children (pointer members = directories,
// scalar members = files, NULL sentinels hidden). Runs the SHARED
// shellcore builtins against a real runtime holding the list.
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

const a1 = await busyboxA1(readFileSync("www/examples/c/linked_list.c", "utf8"), "c", { fs, wasmPath: "/usr/bin/otranspiler-busybox.wasm", goRunner });
const lib = await getOtranspilerl();
const program = JSON.parse(lib.render(JSON.stringify(a1), "js"));
keepVariables(program, []);
const js = await estreeToJs(program);

const stdout = { _buf: "", write(s) { this._buf += s; } };
const stderr = { _buf: "", write(s) { this._buf += s; } };
const rt = createSh2Runtime({ fs, env: {}, shellExec: async () => ({ out: "", err: "", code: 0 }), stdout, stderr, argv0: "bash" });
const proc = { stdout, stderr, env: {}, argv: [], cwd: () => "/" };
await new Function("fs", "env", "process", "sh2", "return (async () => { " + js + " })();")(fs, {}, proc, rt.sh2);
rt.sh2.stdin = "three\ntwo\none\n";
await rt.sh2.fnCall("slurp2", []);
const head = rt.sh2.getVar("last");

// the shell ctx — enough of a shell to drive the shared builtins
const out = { _buf: "", write(s) { this._buf += s; } };
const err = { _buf: "", write(s) { this._buf += s; } };
let bound = null;
const ctx = {
  get otRt() { return rt; },
  stdout: out, stderr: err,
  // a minimal command runner for find -exec: re-enter the builtins
  runNestedCommand: async (cmdline) => {
    const parts = cmdline.trim().split(/\s+/);
    const [cmd, ...a] = parts;
    if (bound && bound[cmd]) {
      // capture the nested command's output like the real runner does
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

let fails = 0;
const check = (name, cond, extra) => {
  if (cond) console.log("PASS: " + name);
  else { fails++; console.log("FAIL: " + name + (extra ? " — " + extra : "")); }
};
const run = async (name, args) => {
  out._buf = ""; err._buf = "";
  const code = await builtins[name](args);
  return { code, out: out._buf, err: err._buf };
};

const handle = String(head);
check("head is a live pointer", /^\u0001mem:\d+:0$/.test(handle), handle);

// cd into the pointer
let r = await run("cd", [handle]);
check("cd into pointer exits 0", r.code === 0, r.err);
r = await run("pwd", []);
check("pwd shows the handle", r.out.trim() === handle, JSON.stringify(r.out));

// find . — the generic walk
r = await run("find", ["."]);
check("find . lists word + next chain", /\.\/word/.test(r.out) && /\.\/next\/next\/word/.test(r.out) && /\.\/next\/next\/next/.test(r.out) === false, JSON.stringify(r.out));
check("find . shows the dir markers", /\.\/next\//.test(r.out), JSON.stringify(r.out));

// find -name word — all scalar members
r = await run("find", [".", "-name", "word"]);
check("find -name word", (r.out.match(/word/g) || []).length === 3, JSON.stringify(r.out));

// find -type d — only directories
r = await run("find", [".", "-type", "d"]);
check("find -type d", /\.\/next\//.test(r.out) && !/word/.test(r.out), JSON.stringify(r.out));

// find -maxdepth 1
r = await run("find", [".", "-maxdepth", "1"]);
check("find -maxdepth 1", /\.\/word/.test(r.out) && !/next\/word/.test(r.out), JSON.stringify(r.out));

// ls — members with dir markers
r = await run("ls", []);
check("ls lists word + next/", r.out.includes("word") && r.out.includes("next/"), JSON.stringify(r.out));

// cd next — descend
r = await run("cd", ["next"]);
check("cd next exits 0", r.code === 0, r.err);
r = await run("pwd", []);
check("pwd shows the chain", r.out.trim() === handle + "/next", JSON.stringify(r.out));
r = await run("find", ["."]);
check("find . inside next", /\.\/word/.test(r.out) && /\.\/next\/word/.test(r.out), JSON.stringify(r.out));

// cd .. — unwind one level
r = await run("cd", [".."]);
check("cd .. exits 0", r.code === 0, r.err);
r = await run("pwd", []);
check("pwd back at root", r.out.trim() === handle, JSON.stringify(r.out));

// multi-component paths: ls next/next/next (the last node — the NULL
// tail hidden)
r = await run("cd", [handle]);
r = await run("ls", ["next/next"]);
check("ls next/next = last node (NULL hidden)", r.out.includes("word") && !r.out.includes("next/"), JSON.stringify(r.out));
r = await run("ls", ["next/next/next"]);
check("ls past the tail is empty", r.out.trim() === "", JSON.stringify(r.out));

// cat reads scalar member values
r = await run("cat", ["word"]);
check("cat word prints the value", r.out.trim() === "one", JSON.stringify(r.out));
r = await run("cat", ["next/word"]);
check("cat next/word", r.out.trim() === "two", JSON.stringify(r.out));
r = await run("cat", ["next"]);
check("cat dir refuses", r.code !== 0 && /is a directory/.test(r.err), JSON.stringify(r.err));

// cd with a multi-component path
r = await run("cd", ["next/next"]);
check("cd next/next exits 0", r.code === 0, r.err);
r = await run("pwd", []);
check("cd next/next pwd", r.out.trim() === handle + "/next/next", JSON.stringify(r.out));
r = await run("cat", ["word"]);
check("cat word after cd next/next", r.out.trim() === "three", JSON.stringify(r.out));

// find a member start point
r = await run("find", ["word"]);
check("find word start point", r.out.trim() === "./word", JSON.stringify(r.out));

// back at the root for the search checks
r = await run("cd", ["../.."]);
r = await run("pwd", []);
check("cd ../.. back to root for grep", r.out.trim() === handle, JSON.stringify(r.out));

// grep searches the pointer's scalar values
r = await run("grep", ["two", "."]);
check("grep two . finds the value", r.out.trim() === "./next/word:two", JSON.stringify(r.out));
r = await run("grep", ["-h", "three", "."]);
check("grep -h three . (no label)", r.out.trim() === "three", JSON.stringify(r.out));
r = await run("grep", ["two", "next/word"]);
check("grep two next/word (single member)", r.out.trim() === "two", JSON.stringify(r.out));

// find . -exec grep -h PATTERN '{}'
r = await run("find", [".", "-name", "word", "-exec", "grep", "-h", "t", "{}"]);
check("find -exec grep -h t", r.out.includes("three") && r.out.includes("two"), JSON.stringify(r.out));

// -exec with -H labels the full member path; the default print is
// suppressed when -exec is given (GNU semantics)
r = await run("find", [".", "-exec", "grep", "-H", "two", "{}"]);
check("find -exec grep -H labels paths", r.out.trim() === "./next/word:two", JSON.stringify(r.out));
check("find -exec suppresses default print", !/^\/\/$/.test(r.out) && !r.out.includes("./next/\n"), JSON.stringify(r.out));

// grep on a single multi-component member labels with the given path
r = await run("grep", ["-H", "two", "next/word"]);
check("grep -H two next/word", r.out.trim() === "next/word:two", JSON.stringify(r.out));

// rg — recursive, default cwd
r = await run("rg", ["two"]);
check("rg two (default cwd)", r.out.trim() === "./next/word:two", JSON.stringify(r.out));
r = await run("rg", ["-i", "THREE"]);
check("rg -i THREE", r.out.trim() === "./next/next/word:three", JSON.stringify(r.out));

// leave pointer mode (back to the real fs)
r = await run("cd", [".."]);
check("cd .. exits pointer mode", r.code === 0, r.err);
check("ptrCwd cleared", !ctx.ptrCwd);

// a scalar member is not a directory
r = await run("cd", [handle]);
await run("cd", ["word"]);
check("cd scalar member fails", r.code === 0 ? (await run("cd", ["word"])).code !== 0 : false, JSON.stringify((await run("cd", ["word"])).err));

// ── cycle safety: a circular list (c1.next = c2, c2.next = c1) must
// terminate in find and grep (the visited guard skips seen boxes) ──
const c1 = rt.sh2.memAlloc(16, "Tag-3468032d");
const c2 = rt.sh2.memAlloc(16, "Tag-3468032d");
rt.sh2.memStore(c1, 0, "char", "alpha");
rt.sh2.memStore(c2, 0, "char", "beta");
rt.sh2.memStore(c1, 8, "char", c2);
rt.sh2.memStore(c2, 8, "char", c1);   // the cycle
await run("cd", [String(c1)]);
r = await run("find", ["."]);
check("find terminates on a cycle", r.out.includes("./word") && r.out.includes("./next/word") && !r.out.includes("./next/next/word"), JSON.stringify(r.out));
r = await run("grep", ["alpha", "."]);
check("grep terminates on a cycle", r.out.includes("alpha") && !/alpha.*alpha/s.test(r.out.replace(/:alpha/g, "")), JSON.stringify(r.out));
r = await run("rg", ["beta"]);
check("rg terminates on a cycle", r.out.includes("beta"), JSON.stringify(r.out));

process.exit(fails ? 1 : 0);
