import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
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
