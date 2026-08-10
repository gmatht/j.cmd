// Headless test of the C linked-list generator+sink (www/examples/c/
// linked_list.c): the transpiled program reads stdin LINES via the
// frontend's read_line() bridge (sh2.readLine), builds a malloc'd
// linked list by PREPENDING, and the sink drains it head-to-tail —
// so the output is the input reversed.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { ensureBusyboxWasm, busyboxA1, BUSYBOX_VERSION } from "./src/busybox.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
import { estreeToJs, keepVariables } from "./src/estree.js";
import { GoRunner, createGoCommand } from "./src/go.js";

const src = readFileSync("www/examples/c/linked_list.c", "utf8");

const goRunner = new GoRunner(fs, { baseUrl: "www/" });
const goCmd = createGoCommand(goRunner, () => {}, (s) => process.stderr.write(s));
const { readFile } = await import("node:fs/promises");
const bytes = new Uint8Array(await readFile("www/wasm-bin/otranspiler-busybox.wasm"));
await fs.writeBlob("/usr/bin/otranspiler-busybox.wasm", new Blob([bytes]));
await fs.write("/usr/bin/otranspiler-busybox.wasm.ver", BUSYBOX_VERSION);
const a1 = await busyboxA1(src, "c", { fs, wasmPath: "/usr/bin/otranspiler-busybox.wasm", goRunner });

const lib = await getOtranspilerl();
const program = JSON.parse(lib.render(JSON.stringify(a1), "js"));
keepVariables(program, []);
const js = await estreeToJs(program);

const stdout = { _buf: "", write(s) { this._buf += s; } };
const stderr = { _buf: "", write(s) { this._buf += s; } };
const shellExec = async () => ({ out: "", err: "", code: 0 });
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout, stderr, argv0: "bash" });
rt.sh2.stdin = "three\ntwo\none\n";

const out = { write: (s) => { stdout._buf += s; } };
const proc = { stdout: out, stderr: { write: (s) => { stderr._buf += s; } }, env: {}, argv: [], cwd: () => "/" };
const fn = new Function("fs", "env", "process", "sh2", "return (async () => { " + js + " })();");
await fn(fs, {}, proc, rt.sh2);

const got = stdout._buf;
process.stderr.write("got: " + JSON.stringify(got) + "\n");
process.stderr.write(got === "one\ntwo\nthree\n" ? "PASS: lines reversed by the linked list\n" : "FAIL: expected one\\ntwo\\nthree\\n\n");
process.exit(got === "one\ntwo\nthree\n" ? 0 : 1);
