// Headless end-to-end test of the C my_qsort + bash comparator demo:
//  1. parse my_qsort.c with the (rebuilt) c-sh-go frontend → A1
//  2. render to JS with the otranspilerl estree backend
//  3. transpile the bash `alphanumeric_compare` comparator
//  4. eval both against one sh2 runtime, check the sorted output.
//
// The C sort calls the comparator by NAME through the `cmp_call` bridge
// (capture + dynamic exec dispatch); the comparator is a real bash
// function whose -1/0/1 echo is captured, not printed.
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
import { ensureBusyboxWasm, busyboxA1, BUSYBOX_VERSION } from "./src/busybox.js";
import { getOtranspilerl } from "./src/otranspilerl.js";
import { estreeToJs, keepVariables } from "./src/estree.js";
import { GoRunner, createGoCommand } from "./src/go.js";

const src = readFileSync("www/examples/c/my_qsort.c", "utf8");

const goRunner = new GoRunner(fs, { baseUrl: "www/" });
const goCmd = createGoCommand(goRunner, () => {}, (s) => process.stderr.write(s));
const { readFile } = await import("node:fs/promises");
const bytes = new Uint8Array(await readFile("www/wasm-bin/otranspiler-busybox.wasm"));
await fs.writeBlob("/usr/bin/otranspiler-busybox.wasm", new Blob([bytes]));
await fs.write("/usr/bin/otranspiler-busybox.wasm.ver", BUSYBOX_VERSION);
const a1 = await busyboxA1(src, "c", { fs, wasmPath: "/usr/bin/otranspiler-busybox.wasm", goRunner });

const lib = await getOtranspilerl();
const program = JSON.parse(lib.render(JSON.stringify(a1), "js"));
// keepVariables — the same pass the shell's runEstreeProgram applies:
// it self-collects the program's setArray calls and emits a STORE SYNC
// (`a = [...]; sh2.setArray("a", a)`), so the array lives in the
// runtime store where my_qsort's `void *base` reads/writes it (without
// it, the read-only-array native-lift would leave the store empty).
keepVariables(program, []);
const cJs = await estreeToJs(program);

// the bash comparator, transpiled the same way the shell would
const bashFn = `
alphanumeric_compare() { if [[ "$1" < "$2" ]]; then echo -1;
                         elif [[ "$1" > "$2" ]]; then echo 1;
                         else echo 0; fi }
`;
const { js: bashJs } = await bashToJS(fs, bashFn);

const stdout = { _buf: "", write(s) { this._buf += s; } };
const stderr = { _buf: "", write(s) { this._buf += s; } };
// the estree printf path writes to process.stdout directly — tee it
// through the runtime's stdout OBJECT (the runtime's capture swaps that
// object's write during a capture, so the comparator's native echoes
// land in the capture buffer, not the terminal).
process.stdout.write = (s) => stdout.write(s);
const shellExec = async (cmdline) => {
  const cl = cmdline.trim();
  if (cl.startsWith("echo ")) return { out: cl.slice(5) + "\n", err: "", code: 0 };
  return { out: "", err: "", code: 0 };
};
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout, stderr, argv0: "bash" });
const sh2 = rt.sh2;

// eval the bash function definition (registers alphanumeric_compare)
await new Function("sh2", "return (async () => { " + bashJs + " })();")(sh2);
if (!sh2.functions.has("alphanumeric_compare")) {
  process.stderr.write("FAIL: comparator not registered\n");
  process.exit(1);
}

// eval the transpiled C program (runs my_qsort with the bash comparator)
await new Function("sh2", "return (async () => { " + cJs + " })();")(sh2);

const lines = stdout._buf.trim().split("\n");
// the demo prints usage instructions first, then the sorted array
const got = lines.find((l) => (l || "").trim() === "apple banana fig pear") || "";
process.stderr.write("got: [" + got.trim() + "]\n");
process.stderr.write(got.trim() === "apple banana fig pear" ? "PASS: sorted alphanumerically\n" : "FAIL: expected apple banana fig pear\n");
process.exit(got.trim() === "apple banana fig pear" ? 0 : 1);
