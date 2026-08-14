// ─── __for-recovery-test.mjs — nativeForLoops pass regression ───────
// Transpiles small scripts and checks BOTH the emitted JS shape (which
// loops were recovered to native `for`) and the runtime behaviour.
//   node __for-recovery-test.mjs
import { readFileSync } from "fs";
import { fs } from "./src/fs/index.js";
import { bashToJS } from "./src/bash2js.js";
import { createSh2Runtime } from "./src/sh2runtime.js";

let fails = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log("PASS: " + name);
  else { fails++; console.log("FAIL: " + name + (extra ? "\n  " + extra : "")); }
};

async function transpile(src) {
  const { js } = await bashToJS(fs, src);
  return js;
}

async function run(src) {
  const { js } = await bashToJS(fs, src);
  const stdout = [];
  const out = { write: (s) => stdout.push(s) };
  const shellExec = async (cmdline) => {
    const cmd = cmdline.trim().split(/\s+/)[0];
    let rest = cmdline.trim().slice(cmd.length).trim();
    if (rest.startsWith("'") && rest.endsWith("'")) rest = rest.slice(1, -1);
    if (cmd === "echo") return { out: rest + "\n", err: "", code: 0 };
    if (cmd === "cat") { try { return { out: await fs.read(rest.split(/\s+/)[0]), err: "", code: 0 }; } catch (e) { return { out: "", err: String(e.message), code: 1 }; } }
    return { out: "", err: "", code: 0 };
  };
  const rt = createSh2Runtime({ fs, env: {}, shellExec, stdout: out, stderr: out, args: [], argv0: "bash" });
  const fn = new Function("args", "fs", "env", "stdout", "stderr", "__runCmd", "sh2",
    "return (async () => { " + js + " })();");
  await Promise.race([
    fn([], fs, {}, out, out, shellExec, rt.sh2),
    new Promise((_, rej) => setTimeout(() => rej(new Error("RUN TIMEOUT")), 4000)),
  ]);
  return stdout.join("");
}

// ── 1. simple counter loop → native for ─────────────────────────────
{
  const src = `i=0
while [ "$i" -lt 5 ]; do
  echo "n=$i"
  i=$((i + 1))
done
echo "after=$i"`;
  const js = await transpile(src);
  check("simple counter loop becomes native for", /for \(i = 0; i < 5; i = i \+ 1\)/.test(js), js.split("\n").filter((l) => l.includes("for (") || l.includes("while")).join(" | "));
  const runOut = await run(src);
  check("loop ran 5 times + post-loop counter value kept", runOut === "n=0\nn=1\nn=2\nn=3\nn=4\nafter=5\n", JSON.stringify(runOut));
}

// ── 2. nested counter loops (gen_maze / render_frame shape) ─────────
{
  const src = `x=0
while [ "$x" -lt 2 ]; do
  y=0
  while [ "$y" -lt 3 ]; do
    echo "($x,$y)"
    y=$((y + 1))
  done
  x=$((x + 1))
done`;
  const js = await transpile(src);
  const fors = (js.match(/for \(/g) || []).length;
  check("nested loops both native for", fors === 2, "fors=" + fors);
  const runOut = await run(src);
  check("nested loop output", runOut === "(0,0)\n(0,1)\n(0,2)\n(1,0)\n(1,1)\n(1,2)\n", JSON.stringify(runOut));
}

// ── 3. loop with a `return` inside (shoot shape) → still converts ───
{
  const src = `f() {
  i=1
  while [ "$i" -le 10 ]; do
    if [ "$i" -eq 4 ]; then
      echo "hit $i"
      return 7
    fi
    i=$((i + 1))
  done
  return 1
}
f
echo "status=$?"`;
  const js = await transpile(src);
  check("return-in-loop still converts to for", /for \(i = 1; i <= 10; i = i \+ 1\)/.test(js), js.split("\n").filter((l) => l.includes("for (")).join(" | "));
  const runOut = await run(src);
  check("return-in-loop behaviour (status 7)", runOut === "hit 4\nstatus=7\n", JSON.stringify(runOut));
}

// ── 4. conditional increment (gm_placed shape) → must NOT convert ───
{
  const src = `placed=0
n=0
while [ "$placed" -lt 3 ]; do
  n=$((n + 1))
  r=$((n % 2))
  if [ "$r" -eq 0 ]; then
    placed=$((placed + 1))
  fi
done
echo "placed=$placed n=$n"`;
  const js = await transpile(src);
  check("conditional increment NOT converted (guard)", /whileLoop/.test(js) && !/for \(placed = 0;/.test(js), js.split("\n").filter((l) => l.includes("for (") || l.includes("while")).join(" | "));
  const runOut = await run(src);
  check("conditional increment behaviour", runOut === "placed=3 n=6\n", JSON.stringify(runOut));
}

// ── 5. loop with break → must NOT convert ───────────────────────────
{
  const src = `i=0
while [ "$i" -lt 10 ]; do
  echo "i=$i"
  if [ "$i" -eq 2 ]; then
    break
  fi
  i=$((i + 1))
done
echo "done=$i"`;
  const js = await transpile(src);
  check("break loop NOT converted (guard)", /whileLoop/.test(js), js.split("\n").filter((l) => l.includes("while") || l.includes("for (")).join(" | "));
  const runOut = await run(src);
  check("break behaviour", runOut === "i=0\ni=1\ni=2\ndone=2\n", JSON.stringify(runOut));
}

// ── 6. counter is ALSO written mid-body → must NOT convert ──────────
{
  const src = `i=0
while [ "$i" -lt 10 ]; do
  if [ "$i" -eq 3 ]; then
    i=8
  fi
  echo "i=$i"
  i=$((i + 1))
done`;
  const js = await transpile(src);
  // the mid-body write blocks FOR recovery (a for-update would clobber
  // it), but the loop still becomes a NATIVE while — the write stays
  // where bash put it
  check("mid-body counter write not a for (native while keeps the write)", /while \(i < 10\)/.test(js) && !/for \(i = 0;/.test(js), js.split("\n").filter((l) => l.includes("while") || l.includes("for (")).join(" | "));
  const runOut = await run(src);
  // bash: when i==3 the if rewrites i to 8 BEFORE the echo, so "i=3"
  // is never printed — the translation matches real bash.
  check("mid-body write behaviour", runOut === "i=0\ni=1\ni=2\ni=8\ni=9\n", JSON.stringify(runOut));
}

// ── 7. pure (await-free) counter loop → NOT converted (the maybeYield
//     guard: a native all-sync loop could freeze the main thread), but a
//     loop whose body awaits DOES convert ──
{
  const pure = `s=""
i=0
while [ "$i" -lt 3 ]; do
  s="$s$i,"
  i=$((i + 1))
done
echo "s=$s"`;
  const js = await transpile(pure);
  check("pure loop stays on whileLoop (maybeYield guard)", /whileLoop/.test(js) && !/for \(i = 0;/.test(js), js.split("\n").filter((l) => l.includes("while") || l.includes("for (")).join(" | "));
  const runOut = await run(pure);
  check("pure loop behaviour", runOut === "s=0,1,2,\n", JSON.stringify(runOut));
}
{
  const mixed = `s=""
i=0
while [ "$i" -lt 3 ]; do
  s="$s$i,"
  echo "tick"
  i=$((i + 1))
done
echo "s=$s"`;
  const js = await transpile(mixed);
  check("awaiting loop converts to for", /for \(i = 0; i < 3; i = i \+ 1\)/.test(js), js.split("\n").filter((l) => l.includes("for (")).join(" | "));
  const runOut = await run(mixed);
  check("awaiting loop behaviour", runOut === "tick\ntick\ntick\ns=0,1,2,\n", JSON.stringify(runOut));
}

// ── 8. while with non-counter condition (rand loop shape) → NOT conv ─
{
  const src = `tries=0
x=0
while [ "$tries" -lt 5 ] && [ "$x" -eq 0 ]; do
  tries=$((tries + 1))
done
echo "tries=$tries"`;
  const js = await transpile(src);
  check("compound-cond loop NOT converted", /whileLoop/.test(js));
}

// ── 9. store counter (mime_at shape) → native for with rewrites, ──
//     post-loop store value preserved by the sync
{
  const src = `a=(1 2 3 4 5)
i=0
while [ "$i" -lt 5 ]; do
  echo "a$i=\${a[$i]}"
  i=$((i + 1))
done
echo "i=$i"`;
  const js = await transpile(src);
  check("store counter becomes native for", /for \(i = 0; sh2\.test\(`"\$\{i\}" -lt 5`\); i = i \+ 1\)/.test(js), js.split("\n").filter((l) => l.includes("for (") || l.includes("while")).join(" | "));
  check("store refs rewritten to native binding", /a\[\$\{i\}\]/.test(js), js.split("\n").find((l) => l.includes("echo")) || "");
  check("store sync after loop", /sh2\.setVar\("i", i\);/.test(js));
  const runOut = await run(src);
  check("store-counter loop behaviour", runOut === "a0=1\na1=2\na2=3\na3=4\na4=5\ni=5\n", JSON.stringify(runOut));
}

// ── 10. same counter name in TWO loops → neither converts ──
{
  const src = `f() {
  n=0
  i=0
  while [ "$i" -lt 2 ]; do
    n=$((n + 1))
    i=$((i + 1))
  done
  echo "f n=$n"
}
g() {
  n=0
  i=0
  while [ "$i" -lt 2 ]; do
    n=$((n + 2))
    i=$((i + 1))
  done
  echo "g n=$n"
}
f
g`;
  const js = await transpile(src);
  check("shared counter name NOT converted (outside refs)", /whileLoop/.test(js), js.split("\n").filter((l) => l.includes("while") || l.includes("for (")).join(" | "));
  const runOut = await run(src);
  check("two-loop behaviour", runOut === "f n=2\ng n=4\n", JSON.stringify(runOut));
}

// ── 11. array-write + param-name rewrites (claim_treasure shape) ──
{
  const src = `T=("aa" "bb" "cc")
f=(0 0 0)
k=0
while [ "$k" -lt 3 ]; do
  f[$k]=1
  echo "\${T[$k]}"
  k=$((k + 1))
done
echo "f2=\${f[2]}"`;
  const js = await transpile(src);
  check("array-write loop converts", /for \(k = 0;/.test(js), js.split("\n").filter((l) => l.includes("for (")).join(" | "));
  const runOut = await run(src);
  check("array-write behaviour", runOut === "aa\nbb\ncc\nf2=1\n", JSON.stringify(runOut));
}

// ── 12. mid-body STORE write to the counter → NOT converted ──
{
  const src = `i=0
while [ "$i" -lt 10 ]; do
  if [ "$i" -eq 3 ]; then
    i=8
  fi
  echo "i=$i"
  i=$((i + 1))
done`;
  const js = await transpile(src);
  check("mid-body store write not a for (native while keeps the write)", /while \(i < 10\)/.test(js) && !/for \(i = 0;/.test(js), js.split("\n").filter((l) => l.includes("while") || l.includes("for (")).join(" | "));
  const runOut = await run(src);
  check("mid-body store write behaviour", runOut === "i=0\ni=1\ni=2\ni=8\ni=9\n", JSON.stringify(runOut));
}

// ── 13. and/or cond flattening (spawn_mime shape) ──
{
  const src = `tries=0
placed=0
while [ "$tries" -lt 5 ] && [ "$placed" -eq 0 ]; do
  echo "try $tries"
  if [ "$tries" -eq 2 ]; then
    placed=1
  fi
  tries=$((tries + 1))
done
echo "placed=$placed"`;
  const js = await transpile(src);
  check("compound cond flattened to native &&", /for \(tries = 0; tries < 5 && placed === 0; tries = tries \+ 1\)/.test(js), js.split("\n").filter((l) => l.includes("for (") || l.includes("while")).join(" | "));
  const runOut = await run(src);
  check("compound cond behaviour", runOut === "try 0\ntry 1\ntry 2\nplaced=1\n", JSON.stringify(runOut));
}

// ── 14. store counter with an in-loop return (kill_mime_at shape) ──
{
  const src = `m=(0 1 2 3)
f() {
  i=0
  while [ "$i" -lt 4 ]; do
    if [ "$i" -eq 2 ]; then
      echo "found $i"
      return 5
    fi
    i=$((i + 1))
  done
  return 1
}
f
echo "status=$?"`;
  const js = await transpile(src);
  check("store loop with return converts", /for \(i = 0;/.test(js), js.split("\n").filter((l) => l.includes("for (") || l.includes("while")).join(" | "));
  const runOut = await run(src);
  check("store loop with return behaviour", runOut === "found 2\nstatus=5\n", JSON.stringify(runOut));
}

// ── 15. store init a few statements back (can_step shape) ──
{
  const src = `j=0
c=1
while [ "$j" -lt 3 ]; do
  echo "j=$j c=$c"
  j=$((j + 1))
done`;
  const js = await transpile(src);
  check("store init scan-back converts", /for \(j = 0; j < 3; j = j \+ 1\)/.test(js), js.split("\n").filter((l) => l.includes("for (") || l.includes("while")).join(" | "));
  const runOut = await run(src);
  check("scan-back behaviour", runOut === "j=0 c=1\nj=1 c=1\nj=2 c=1\n", JSON.stringify(runOut));
}

// ── 16. awaiting loop with a CONDITIONAL increment (gm_placed shape) ──
//     can't be a for (the update isn't unconditional), but becomes a
//     NATIVE while — the increment stays in the body where bash put it
{
  const src = `placed=0
n=0
while [ "$placed" -lt 3 ]; do
  echo "n=$n"
  n=$((n + 1))
  r=$((n % 2))
  if [ "$r" -eq 0 ]; then
    placed=$((placed + 1))
  fi
done
echo "placed=$placed n=$n"`;
  const js = await transpile(src);
  check("conditional increment becomes native while", /while \(placed < 3\)/.test(js) && !/for \(placed = 0;/.test(js), js.split("\n").filter((l) => l.includes("while") || l.includes("for (")).join(" | "));
  const runOut = await run(src);
  check("conditional increment native-while behaviour", runOut === "n=0\nn=1\nn=2\nn=3\nn=4\nn=5\nplaced=3 n=6\n", JSON.stringify(runOut));
}

// ── 17. main-game-loop shape: compound cond + counter not last + body ──
//     writes to the cond vars → native while, flat && cond
{
  const src = `frame=0
quit=0
hp=3
while [ "$quit" -eq 0 ] && [ "$hp" -gt 0 ]; do
  frame=$((frame + 1))
  echo "tick $frame"
  if [ "$frame" -eq 2 ]; then
    hp=0
  fi
done
echo "frame=$frame hp=$hp"`;
  const js = await transpile(src);
  check("game-loop shape becomes native while", /while \(quit === 0 && hp > 0\)/.test(js), js.split("\n").filter((l) => l.includes("while") || l.includes("for (")).join(" | "));
  const runOut = await run(src);
  check("game-loop behaviour", runOut === "tick 1\ntick 2\nframe=2 hp=0\n", JSON.stringify(runOut));
}

if (fails) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
console.log("\nALL FOR-RECOVERY CHECKS PASSED");

// ── 18. `await sh2.and(...)` in an if-condition → flattened to &&, ──
//     and the function becomes lowerable (mime_at shape)
{
  const src = `a=(1 2 3)
f() {
  x=${'$'}{a[0]}
  y=${'$'}{a[1]}
  if [ "$x" -eq 1 ] && [ "$y" -eq 2 ]; then
    echo "match"
  fi
}
f`;
  const js = await transpile(src);
  check("if-condition and() flattened to native &&", /&&/.test(js) && !/sh2\.and/.test(js), js.split("\n").filter((l) => l.includes("&&") || l.includes("and(")).join(" | "));
  const runOut = await run(src);
  check("flattened and() behaviour", runOut === "match\n", JSON.stringify(runOut));
}

// ── 19. a PURE function whose only await was the if-and() gets lowered ──
{
  const src = `q() {
  if [ "1" -eq 1 ] && [ "2" -eq 2 ]; then
    r=1
  fi
}
q
echo "r=$r"`;
  const js = await transpile(src);
  check("and-only pure function lowered to native fn", /function q\(\)/.test(js), js.split("\n").filter((l) => l.includes("function q") || l.includes("define(\"q\"")).join(" | "));
  const runOut = await run(src);
  check("lowered pure function behaviour", runOut === "r=1\n", JSON.stringify(runOut));
}

// ── 20. `echo X > /dev/…` compiles to a direct fs.write ──
{
  const src = `echo "1 2 3" > /dev/webgl/uniform/3f/uScale
echo "0.5" > /dev/webgl/uniform/1f/uOverlay
cat /dev/webgl/uniform/3f/uScale`;
  const js = await transpile(src);
  check("echo > device compiles to fs.write", /fs\.write\("\/dev\/webgl\/uniform\/3f\/uScale", `1 2 3` \+ "\\n"\)/.test(js), js.split("\n").filter((l) => l.includes("fs.write") || l.includes("redirect")).join(" | "));
  const runOut = await run(src);
  check("device write + readback", runOut === "3f 1 2 3\n", JSON.stringify(runOut));
}

// ── 21. non-literal / multi-arg / &2 redirects are NOT compiled ──
{
  const src = `echo "to stderr" >&2
echo a b > /dev/webgl/uniform/3f/uM
echo "keep" > /tmp/x`;
  const js = await transpile(src);
  check("stderr/multi-arg redirects stay on the runtime", /sh2\.redirect/.test(js) && /"a", "b"/.test(js), js.split("\n").filter((l) => l.includes("redirect")).join(" | "));
}
