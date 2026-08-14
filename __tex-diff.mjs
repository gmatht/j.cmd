// ─── __tex-diff.mjs — byte-compare + time old vs new transpiled output ─
// Runs a generated texture-grass.js with a printf-aware stub and diffs
// the stdout between two versions (determinism / behavior preservation).
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

async function runAndCapture(jsPath) {
  const js = readFileSync(jsPath, "utf8");
  const stdout = [];
  const out = { write: (s) => stdout.push(s) };
  const shellExec = async (cmdline) => {
    const cl = cmdline.trim();
    const cmd = cl.split(/\s+/)[0];
    let rest = cl.slice(cmd.length).trim();
    if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
    if (cmd === "printf") {
      // %03o / %d / %s — emit the formatted bytes the way the shell would
      const args = rest.split(/\s+/);
      const fmt = args[0];
      let s = fmt;
      args.slice(1).forEach((a, i) => {
        const m = fmt.match(/%([0-9]*)o|%([0-9]*)d|%s/g);
        if (m && m[i]) {
          const spec = m[i];
          const n = Number(a) || 0;
          let v;
          if (spec.includes("o")) v = n.toString(8);
          else if (spec.includes("d")) v = String(n);
          else v = a;
          const w = parseInt(spec.slice(1), 10) || 0;
          if (w) v = v.padStart(w, "0");
          s = s.replace(spec, v);
        }
      });
      return { out: s, err: "", code: 0 };
    }
    if (cmd === "convert" || cmd === "command" || cmd === "echo" || cmd === "true") return { out: "", err: "", code: 0 };
    return { out: "", err: "", code: 0 };
  };
  const rt = createSh2Runtime({ fs, env: { TEX_SIZE: "32" }, shellExec, stdout: out, stderr: out, args: [], argv0: "bash" });
  const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2",
    "return (async () => { " + js + " })();");
  const t0 = process.hrtime.bigint();
  await fn([], fs, { TEX_SIZE: "32" }, out, out, shellExec, rt.sh2);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { out: stdout.join(""), ms };
}

const [oldRes, newRes] = await Promise.all([
  runAndCapture("/tmp/texture-grass-old.js"),
  runAndCapture("/tmp/texture-grass-new.js"),
]);
console.log("old:", oldRes.out.length, "bytes,", oldRes.ms.toFixed(1), "ms");
console.log("new:", newRes.out.length, "bytes,", newRes.ms.toFixed(1), "ms");
if (oldRes.out === newRes.out) console.log("✓ IDENTICAL stdout (behavior preserved)");
else {
  console.log("✗ OUTPUT DIFFERS!");
  const a = oldRes.out, b = newRes.out;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) { console.log("first diff at byte", i, JSON.stringify(a.slice(i - 20, i + 20)), "vs", JSON.stringify(b.slice(i - 20, i + 20))); break; }
  }
}
