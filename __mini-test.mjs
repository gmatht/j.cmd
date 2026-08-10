import { fs } from "./src/fs/index.js";
import { bashToJS, runBash } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";
const mini = `
map=("###" "#P#" "###")
draws_n=0
wr=0
while [ $wr -lt \${#map[@]} ]; do
  wl=\${map[$wr]}
  wc=0
  while [ $wc -lt \${#wl} ]; do
    wv=\${wl:$wc:1}
    if [ "$wv" = "#" ]; then
      draws_n=$((draws_n+1))
    fi
    wc=$((wc+1))
  done
  wr=$((wr+1))
done
echo "draws_n=$draws_n"
`;
const { js } = await bashToJS(fs, mini);
console.log("JS snippet:", js.includes("arrayLen"), js.includes("arrayIndex"), js.includes("param"));
const stdout = [];
const shellExec = async (cmdline) => {
  const cl = cmdline.trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  if (cmd === "echo") return { out: rest + "\n", err: "", code: 0 };
  return { out: "", err: "", code: 0 };
};
const out = { write: (s) => stdout.push(s) };
const err = { write: (s) => stdout.push("[err] " + s) };
const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: err, args: [], argv0: "bash" });
const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2",
  "return (async () => { " + js + " })();");
await fn([], fs, {}, out, err, shellExec, rt.sh2);
console.log("mini result:", JSON.stringify(stdout.join("")));

// ─── regression: $? must survive the bash REPL's marker echo ──
// The REPL brackets each new line with echo '<pre>' / echo '<post>'
// and passes both strings as runBash's `markers`, which rewrites them
// to direct stdout writes so the PRE marker can't clobber $?. Without
// that, `false` followed by `echo $?` prints 0 instead of 1.
const replExec = async (cmdline) => {
  const cl = cmdline.trim();
  const cmd = cl.split(/\s+/)[0];
  let rest = cl.slice(cmd.length).trim();
  if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
  if (cmd === "echo") return { out: rest + "\n", err: "", code: 0 };
  if (cmd === "false") return { out: "", err: "", code: 1 };
  return { out: "", err: "", code: 0 };
};
const rOut = [], rErr = [];
await runBash(fs, `false\necho '__pre__'\necho $?\necho '__post__'\n`, {
  runCmd: replExec,
  markers: ["__pre__", "__post__"],
  stdout: { write: (s) => rOut.push(s) },
  stderr: { write: (s) => rErr.push(s) },
});
const between = rOut.join("").split("__pre__\n")[1].split("__post__")[0];
console.log("marker $? regression:", JSON.stringify(between), between === "1\n" ? "PASS" : "FAIL");

// ─── regression: `return N` inside a function sets $? ──────────
const fOut = [];
await runBash(fs, `g() { return 7; }\ng\necho $?\nh() { false; }\nh\necho $?\n`, {
  runCmd: replExec,
  stdout: { write: (s) => fOut.push(s) },
  stderr: { write: (s) => {} },
});
console.log("function return $? regression:", JSON.stringify(fOut.join("")), fOut.join("") === "7\n1\n" ? "PASS" : "FAIL");
