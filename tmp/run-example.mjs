import { execFileSync } from "node:child_process";
import { readFileSync } from "fs";
import { getOtranspilerl } from "../src/otranspilerl.js";
import { estreeToJs } from "../src/estree.js";
import { fs } from "../src/fs/index.js";
import { createSh2Runtime } from "../src/sh2runtime.js";
const path = process.argv[2];
const src = readFileSync(path, "utf8");
const expected = execFileSync("bash", [path]).toString();
const lib = await getOtranspilerl();
const out = lib.compile(src);
const estree = typeof out === "string" ? JSON.parse(out) : out;
const program = estree.estree || estree;
const bodyJs = await estreeToJs({ type: "Program", body: program.body || [] }, { repl: false });
const collected = [];
const ow = process.stdout.write.bind(process.stdout);
process.stdout.write = (s, ...rest) => { collected.push(String(s)); return ow(s, ...rest); };
const sink = { write: (s) => { if (s) collected.push(String(s)); return true; } };
const shellExec = async (cmdline, stdin) => {
  const cl = String(cmdline || "").trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  let o = "";
  if (cmd === "echo") o = rest + "\n";
  else if (cmd === "printf") o = rest.replace(/%s/g, "").replace(/"/g, "");
  else if (cmd === "sleep") { await new Promise((r) => setTimeout(r, 0)); }
  else if (cmd === "true") {}
  return { out: o, err: "", code: 0 };
};
const rt = createSh2Runtime({ fs, env: { HOME: "/home" }, shellExec, stdout: sink, stderr: sink, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2", "return (async () => { " + bodyJs + " })();");
try { await fn([], fs, { HOME: "/home" }, sink, sink, shellExec, rt.sh2); } catch (e) { console.log("RUN ERR:", e.message.slice(0, 200)); }
const got = collected.join("");
console.log("expected:", JSON.stringify(expected), " got:", JSON.stringify(got), got === expected ? "MATCH ✓" : "MISMATCH ✗ (bug reproduced)");
