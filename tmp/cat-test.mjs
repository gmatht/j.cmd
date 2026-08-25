import { fs } from "../src/fs/index.js";
const { builtins } = await import("../src/shellcore/builtins.js");

await fs.write("/tmp/hello.txt", "line one\n\nline three\nline four\n");

async function runCat(argv) {
  let out = "";
  const ctx = {
    stdout: { write: (s) => { out += String(s); } },
    stderr: { write: (s) => { out += "[err] " + String(s); } },
    ptrCwd: null,
    nodeEnv: {},
    nodeCwd: () => "/",
  };
  const code = await builtins.cat.call({ fs, builtins }, ctx, argv);
  return { out, code };
}

console.log("=== cat -n hello.txt ===");
console.log((await runCat(["-n", "/tmp/hello.txt"])).out);
console.log("=== cat -b hello.txt ===");
console.log((await runCat(["-b", "/tmp/hello.txt"])).out);
console.log("=== cat hello.txt (plain, still works) ===");
console.log((await runCat(["/tmp/hello.txt"])).out);
