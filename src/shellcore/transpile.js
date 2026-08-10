// ─── shellcore/transpile.js — SHARED transpiler helpers ─────────
// The stateless pieces of the persistent-transpile machinery both
// shells duplicate. The STATE (otRt, otVars) stays per-shell — it is
// execution state the line handlers weave through — but these helpers
// are pure / state-passed, so there is one implementation.
import { fs } from "../fs/index.js";
import { env, isReadonly } from "../env.js";

export function a1LiteralValue(expr) {
  if (!expr) return undefined;
  if (expr.type === "Str") return String(expr.value ?? "");
  if (expr.type === "Num" || expr.type === "Bool") return String(expr.value ?? "");
  // Arith: `set /a X=2+3` — the bat-sh-go frontend emits constant
  // arithmetic as {type:"Arith", ast:{Bin …}}; evaluate it statically so
  // the value survives the harvest (the $(( )) render hoists a let).
  if (expr.type === "Arith" && expr.ast) {
    const evalBin = (n) => {
      if (!n) return undefined;
      if (n.type === "Num") return Number(n.value);
      if (n.type === "Bin") {
        const l = evalBin(n.lhs), r = evalBin(n.rhs);
        if (l === undefined || r === undefined) return undefined;
        switch (n.op) {
          case "+": return l + r;
          case "-": return l - r;
          case "*": return l * r;
          case "/": return l / r;
          case "%": return l % r;
        }
        return undefined;
      }
      return undefined;   // a %var% operand — can't resolve statically
    };
    const v = evalBin(expr.ast);
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return undefined;
  }
  if (expr.type === "Interpolate" && Array.isArray(expr.parts)) {
    // concatenate literal parts + statically resolvable getVar parts
    // (`DEVDIR=$HOME/dev` — the eval hoists a `let DEVDIR`, invisible
    // to the runtime diff, so resolve it here from env/otVars)
    let out = "";
    for (const p of expr.parts) {
      if (p && p.kind === "lit") { out += String(p.text ?? ""); continue; }
      if (p && p.kind === "expr" && p.expr && p.expr.type === "Call" &&
          p.expr.func === "getVar" && p.expr.args && p.expr.args[0] && p.expr.args[0].type === "Str") {
        const name = p.expr.args[0].value;
        if (otVars.has(name)) out += Array.isArray(otVars.get(name)) ? otVars.get(name).join(" ") : String(otVars.get(name));
        else if (env[name] !== undefined) out += String(env[name]);
        else out += "";
        continue;
      }
      return undefined;   // computed part we can't resolve statically
    }
    return out;
  }
  if (expr.type === "Call" && expr.func === "setArray" &&
      expr.args && expr.args[1] && expr.args[1].type === "Array") {
    const out = [];
    for (const el of expr.args[1].elements || []) {
      if (el && el.type === "Str") out.push(String(el.value ?? ""));
      else return undefined;
    }
    return out;
  }
  return undefined;
}

// Mirror the persistent runtime's store back into otVars after a NATIVE
// command that mutated it through sh2 (e.g. a sourced C function sorted
// an array in place). `otRt`/`otVars` are passed in — each shell owns
// its instances.
export function syncOtVarsFromStore(otRt, otVars) {
  if (!otRt || !otRt.sh2 || !otRt.sh2.vars) return;
  const keepable = (val) => typeof val === "string" || typeof val === "number" || Array.isArray(val);
  for (const k of Object.keys(otRt.sh2.vars)) {
    const val = otRt.sh2.vars[k];
    if (!keepable(val) || k.startsWith("__")) continue;
    if (isReadonly(k)) continue;
    otVars.set(k, Array.isArray(val) ? val : String(val));
  }
  // mirror into the shell's env too — a NATIVE line after the call
  // (`echo "a=($a)"`) expands $NAME from env, which the transpiled
  // runEstreeProgram mirror normally refreshes; a native fnCall
  // dispatch (findCommand → sh2.fnCall) must do the same or it sees
  // the stale pre-call value.
  for (const [k, v] of otVars) {
    if (isReadonly(k)) continue;
    try { env[k] = Array.isArray(v) ? v.join(" ") : String(v); } catch {}
  }
}

// ─── runSourceContent: source a transpiled file in the current shell ──
// SHARED by the CLI and the browser shell (the `source` / `.` builtin in
// shellcore/builtins.js dispatches here via ctx.runSourceContent). The
// frontend work is common: sh/zsh → shir; everything else → the unified
// busybox frontend; then the A1 literal harvest. The final program eval
// differs per shell (the CLI's runEstreeProgram vs the browser's
// evalOnOtRt), so the shell passes ctx.evalProgram.
//
// ctx: { runJsSourceContent, getOtVars, fetchBusyboxBytes, goRunner,
//        goCmd, evalProgram(program, lineAssigned, srcArgs) }
export async function runSourceContent(content, lang, srcArgs, ctx) {
  if (lang === "js") return await ctx.runJsSourceContent(content, srcArgs);
  const { getOtranspilerl } = await import("../otranspilerl.js");
  const lib = await getOtranspilerl();
  const otVars = ctx.getOtVars();
  let a1;
  if (lang === "sh" || lang === "zsh") {
    // Seed the shell's known variables so $x reads compile live — the
    // same seeding the line fallback does.
    const seed = [...otVars].map(([k, v]) =>
      Array.isArray(v)
        ? `${k}=(${v.map((x) => JSON.stringify(String(x))).join(" ")});`
        : `${k}=${JSON.stringify(String(v))};`
    ).join("");
    a1 = JSON.parse(lib.shir(seed + String(content)));
  } else {
    const { ensureBusyboxWasm, busyboxA1 } = await import("../busybox.js");
    const wasmPath = await ensureBusyboxWasm(fs, {
      goRunner: ctx.goRunner, goCmd: ctx.goCmd, fetchBytes: ctx.fetchBusyboxBytes,
    });
    a1 = await busyboxA1(String(content), lang, { fs, wasmPath, goRunner: ctx.goRunner });
    // the otranspilerl renderer panics on Goto/Label — refuse loudly up
    // front (REFUSE > GUESS) instead of crashing
    if (a1 && Array.isArray(a1.stmts)) {
      for (const st of a1.stmts) {
        if (st && (st.type === "Goto" || st.type === "Label")) {
          throw new Error("goto/labels are not supported by the jtsh renderer yet (the debashc verify pipeline can render them)");
        }
      }
    }
  }
  const program = JSON.parse(lib.render(JSON.stringify(a1), "js"));
  // A1 literal harvest: deterministic assignment values (Str/Num/Bool/
  // all-lit Interpolate/setArray) — pre-seeds otVars so a sourced
  // `int counter = 42` shows up as $counter even though the generated
  // `let counter = 42` is eval-scoped (invisible to the runtime diff).
  const lineAssigned = new Set();
  try {
    for (const st of (a1 && a1.stmts) || []) {
      if (st && st.type === "Assign" && st.targets && st.targets[0]) {
        const t = st.targets[0];
        if (t.var && !(t.indices && t.indices.length)) {
          lineAssigned.add(t.var);
          const val = a1LiteralValue(st.expr);
          if (val !== undefined) otVars.set(t.var, val);
        }
      }
    }
  } catch {}
  return await ctx.evalProgram(program, lineAssigned, srcArgs);
}
