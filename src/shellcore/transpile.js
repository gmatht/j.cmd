// ─── shellcore/transpile.js — SHARED transpiler helpers ─────────
// The stateless pieces of the persistent-transpile machinery both
// shells duplicate. The STATE (otRt, otVars) stays per-shell — it is
// execution state the line handlers weave through — but these helpers
// are pure / state-passed, so there is one implementation.
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
