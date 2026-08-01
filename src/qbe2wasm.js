// ─── qbe2wasm: QBE IR → WebAssembly (wasm32) backend ───────────
//
// Compiles the QBE IL text format (as emitted by cproc) into a wasm32
// binary module. Design notes:
//
//  - cproc's IR is memory-based, not SSA: locals live on the stack via
//    alloc4/8 + load/store, so the only phis are explicit `phi` nodes
//    (conditional-expression results). We lower phis to a local that
//    each predecessor stores into at its end.
//  - Every temp gets a wasm local (params first). QBE pointers are `l`
//    (64-bit) but wasm32 addresses are i32, so memory operands wrap
//    with i32.wrap_i64 and alloc results sign/zero-extend sp.
//  - allocN bumps a module-level stack pointer global in linear memory;
//    static data (strings, globals) live in a data segment below it.
//  - `s_1.5` / `d_25` operands are QBE float literals (not symbols),
//    parsed into f32.const/f64.const.
//  - Control flow: cproc emits reducible structured CFGs (if/else with
//    join, if/else with returns, while/for/do-while with break/continue,
//    switch chains). We lower them to wasm block/loop/if; anything else
//    errors clearly.
//  - `call extern $f` resolves to the in-module $f when defined, else to
//    a wasm import of the same signature (the host provides it).
//  - `{ wasm64: true }` emits a memory64 module: the stack pointer global,
//    alloc results and all address operands are genuine i64 — no wrap/extend
//    conversions, and >4GiB addressable. Chrome/Node ≥ memory64; probe before
//    using (wasm32 is the safe default).
//
// Usage: qbe2wasm(irText, { importBase, wasm64 }) → Uint8Array (wasm binary)
// -----------------------------------------------------------------

// ─── wasm binary writer ─────────────────────────────────────────

function uleb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}
function sleb(n) {   // n: BigInt (signed 64-bit)
  const out = [];
  let more = true;
  while (more) {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if ((n === 0n && (b & 0x40) === 0) || (n === -1n && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}
const flatten = (a, out = []) => { for (const x of a) Array.isArray(x) ? flatten(x, out) : out.push(x); return out; };
const bytes = (...arrs) => flatten(arrs);
const strBytes = (s) => flatten([...s].map((c) => c.charCodeAt(0) & 0xff));
const vec = (arr) => { const flat = flatten(arr); return bytes(uleb(flat.length), flat); };

// value type codes
const I32 = 0x7f, I64 = 0x7e, S = 0x7d, D = 0x7c, VOID = 0x40;
const W = I32, L = I64;

// wasm opcodes
const OP = {
  block: 0x02, loop: 0x03, if_: 0x04, else_: 0x05, end: 0x0b,
  br: 0x0c, br_if: 0x0d, return_: 0x0f, call: 0x10,
  local_get: 0x20, local_set: 0x21, global_get: 0x23, global_set: 0x24,
  i32_load: 0x28, i64_load: 0x29, f32_load: 0x2a, f64_load: 0x2b,
  i32_load8_s: 0x2c, i32_load8_u: 0x2d, i32_load16_s: 0x2e, i32_load16_u: 0x2f,
  i32_store: 0x36, i64_store: 0x37, f32_store: 0x38, f64_store: 0x39,
  i32_store8: 0x3a, i32_store16: 0x3b,
  i32_const: 0x41, i64_const: 0x42, f32_const: 0x43, f64_const: 0x44,
  i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_lt_u: 0x49,
  i32_gt_s: 0x4a, i32_gt_u: 0x4b, i32_le_s: 0x4c, i32_le_u: 0x4d, i32_ge_s: 0x4e, i32_ge_u: 0x4f,
  i64_eq: 0x50, i64_ne: 0x51, i64_lt_s: 0x52, i64_lt_u: 0x53, i64_gt_s: 0x54, i64_gt_u: 0x55,
  i64_le_s: 0x56, i64_le_u: 0x57, i64_ge_s: 0x58, i64_ge_u: 0x59,
  f32_eq: 0x5b, f32_ne: 0x5c, f32_lt: 0x5d, f32_gt: 0x5e, f32_le: 0x5f, f32_ge: 0x60,
  f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
  i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_div_u: 0x6e,
  i32_rem_s: 0x6f, i32_rem_u: 0x70, i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73,
  i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
  i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_div_s: 0x7f, i64_div_u: 0x80,
  i64_rem_s: 0x81, i64_rem_u: 0x82, i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85,
  i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88,
  f32_neg: 0x8c, f32_abs: 0x8b, f32_sqrt: 0x91,
  f32_add: 0x92, f32_sub: 0x93, f32_mul: 0x94, f32_div: 0x95,
  f64_neg: 0x9a, f64_abs: 0x99, f64_sqrt: 0x9f,
  f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2, f64_div: 0xa3,
  i32_wrap_i64: 0xa7, i32_trunc_f32_s: 0xa8, i32_trunc_f32_u: 0xa9,
  i32_trunc_f64_s: 0xaa, i32_trunc_f64_u: 0xab,
  i64_extend_i32_s: 0xac, i64_extend_i32_u: 0xad,
  i64_trunc_f32_s: 0xae, i64_trunc_f32_u: 0xaf, i64_trunc_f64_s: 0xb0, i64_trunc_f64_u: 0xb1,
  f32_convert_i32_s: 0xb2, f32_convert_i32_u: 0xb3, f32_convert_i64_s: 0xb4, f32_convert_i64_u: 0xb5,
  f32_demote_f64: 0xb6, f64_convert_i32_s: 0xb7, f64_convert_i32_u: 0xb8,
  f64_convert_i64_s: 0xb9, f64_convert_i64_u: 0xba, f64_promote_f32: 0xbb,
  i32_extend8_s: 0xc0, i32_extend8_u: 0xc1, i32_extend16_s: 0xc2, i32_extend16_u: 0xc3,
};

const memarg = (align) => bytes(uleb(align), uleb(0));  // align (log2), offset 0

// ─── QBE IR parser ─────────────────────────────────────────────

const FLOAT_RE = /^[sd]_[-0-9.eE+]+$/;

function parseIr(text) {
  const s = text.replace(/#[^\n]*/g, "");
  const tokRe = /\$[A-Za-z0-9_.]+|%[A-Za-z0-9_.]+|@[A-Za-z0-9_.]+|:[A-Za-z0-9_.]+|0x[0-9a-fA-F]+|-?\d*\.\d+([eE][+-]?\d+)?|-?\d+[eE][+-]?\d+|[sd]_[-0-9.eE+]+|-?\d+|"[^"]*"|[A-Za-z0-9_.]+|[{}()=,+\-]|\.\.\./g;
  const tokens = [];
  const tokLine = [];
  let m;
  while ((m = tokRe.exec(s)) !== null) {
    tokens.push(m[0]);
    tokLine.push(s.slice(0, m.index).split("\n").length);
  }
  const onSameLine = (i) => tokLine[i] === tokLine[pos];
  const stmtLine = () => tokLine[pos - 1];

  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (t) => { const x = next(); if (x !== t) throw new Error(`qbe: expected '${t}', got '${x}'`); };

  const module = { data: [], funcs: [], types: new Map() };

  function parseData() {
    const name = next();
    // data $name [= align N] { items }
    const items = [];
    if (peek() === "=") {
      next();
      if (peek() === "align") { next(); next(); }
    }
    expect("{");
    while (peek() !== "}") {
      const t = next();
      if (t === ",") continue;
      if (t === "align") { next(); next(); continue; }
      const v = next();
      if (peek() === ",") next();
      items.push({ type: t, value: v });
    }
    expect("}");
    module.data.push({ name, items });
  }

  function parseStmt(first) {
    if (first.startsWith("%")) {
      const tmp = first;
      expect("=");
      let type = next();
      if (type.startsWith("=")) type = type.slice(1);
      const op = next();
      if (op === "call") {
        let isExtern = false, fname, args = [];
        if (peek() === "extern") { next(); isExtern = true; }
        fname = next();
        if (peek() === "(") {
          next();
          while (peek() !== ")") {
            if (peek() === "," || peek() === "...") { next(); continue; }
            const at = next(), av = next();
            args.push({ type: at, value: av });
            if (peek() === ",") next();
          }
          expect(")");
        }
        return { kind: "op", tmp, type, op: "call", fname, extern: isExtern, args };
      }
      const args = [];
      const line0 = stmtLine();
      while (pos < tokens.length && tokLine[pos] === line0) {
        const t = peek();
        if (t === "," || t === "(" || t === ")") { next(); continue; }
        if (t === "extern") { next(); args.push("extern"); continue; }
        if (t.startsWith("%") || t.startsWith("@") || t.startsWith("$") ||
            /^-?\d+$/.test(t) || /^0x/.test(t) || FLOAT_RE.test(t) || /^-?\d*\.\d/.test(t)) {
          args.push(next());
          continue;
        }
        break;
      }
      return { kind: "op", tmp, type, op, args };
    }
    if (first.startsWith("call")) {
      let isExtern = false, fname, args = [];
      if (peek() === "extern") { next(); isExtern = true; }
      fname = next();
      if (peek() === "(") {
        next();
        while (peek() !== ")") {
          if (peek() === "," || peek() === "...") { next(); continue; }
          const at = next(), av = next();
          args.push({ type: at, value: av });
          if (peek() === ",") next();
        }
        expect(")");
      }
      return { kind: "op", tmp: null, type: null, op: "call", fname, extern: isExtern, args };
    }
    if (first === "storew" || first === "storel" || first === "storeb" || first === "storeh" ||
        first === "stores" || first === "stored") {
      const v = next(); expect(",");
      const p = next();
      return { kind: "store", op: first, value: v, ptr: p };
    }
    if (first === "ret") {
      const v = peek();
      if (v !== undefined && (v.startsWith("%") || /^-?\d+$/.test(v) || /^0x/.test(v) || FLOAT_RE.test(v) || v.startsWith("$"))) {
        return { kind: "ret", value: next() };
      }
      return { kind: "ret", value: null };
    }
    if (first === "jnz") {
      const c = next(); expect(",");
      const t = next(); expect(",");
      const f = next();
      return { kind: "jnz", cond: c, t, f };
    }
    if (first === "jmp") return { kind: "jmp", target: next() };
    if (first === "hlt") return { kind: "hlt" };
    if (first === "blit") {
      const a = next(); expect(",");
      const b = next(); expect(",");
      const c = next();
      return { kind: "op", tmp: null, type: null, op: "blit", args: [a, b, c] };
    }
    throw new Error(`qbe: unsupported statement '${first}'`);
  }

  function parseFunction() {
    let retType = peek();
    if (retType.startsWith("$")) retType = "v";  // void function: no return type
    else next();
    const name = next();
    expect("(");
    const params = [];
    while (peek() !== ")") {
      if (peek() === "..." || peek() === ",") { next(); continue; }
      const pt = next(), pn = next();
      params.push({ type: pt, name: pn });
      if (peek() === ",") next();
    }
    expect(")");
    expect("{");
    const blocks = [];
    let cur = null;
    while (peek() !== "}") {
      const tk = next();
      if (tk.startsWith("@")) {
        if (cur) blocks.push(cur);
        cur = { label: tk, stmts: [] };
      } else {
        if (!cur) cur = { label: "@start", stmts: [] };
        cur.stmts.push(parseStmt(tk));
      }
    }
    if (cur) blocks.push(cur);
    expect("}");
    module.funcs.push({ exported: true, retType, name, params, blocks });
  }

  while (pos < tokens.length) {
    const t = next();
    if (t === "type") {
      // struct type declarations — layout already lowered by cproc
      while (pos < tokens.length && peek() !== "type" && peek() !== "data" &&
             peek() !== "export" && peek() !== "function" && peek() !== "thread") {
        if (next() === "}") break;
      }
    } else if (t === "data") parseData();
    else if (t === "export") {
      const kw = next();
      if (kw === "function") parseFunction();
      else if (kw === "data") parseData();
      else if (kw === "thread") { next(); parseData(); }
      else throw new Error(`qbe: unexpected export ${kw}`);
    } else if (t === "function") parseFunction();
    else if (t === "thread") { next(); parseData(); }
    // stray tokens ignored
  }
  return module;
}

// ─── codegen ────────────────────────────────────────────────────

const QBE_TYPE_TO_WASM = { w: I32, l: I64, s: S, d: D, b: I32, h: I32, v: VOID };

function genFunction(fn, mod) {
  const wasm64 = !!mod.wasm64;
  const PTR = wasm64 ? I64 : I32;   // address type: wasm32 or memory64
  const code = [];
  const emit = (...b) => code.push(...b);

  const blockByName = new Map();
  fn.blocks.forEach((b) => blockByName.set(b.label, b));

  // temps → locals (params first)
  const localIdx = new Map();
  const locals = [...fn.params];
  fn.params.forEach((p, i) => localIdx.set(p.name, i));
  const tempType = new Map();
  fn.params.forEach((p) => tempType.set(p.name, p.type));
  const allocLocal = (name, type) => {
    if (!localIdx.has(name)) {
      localIdx.set(name, locals.length);
      locals.push({ name, type });
    }
    return localIdx.get(name);
  };
  const phiIn = new Map();   // predLabel → [{tmp, value}]
  for (const b of fn.blocks) {
    for (const st of b.stmts) {
      if (st.kind === "op") {
        if (st.tmp) tempType.set(st.tmp, st.type);
        if (st.op === "phi") {
          for (let i = 0; i + 1 < st.args.length; i += 2) {
            const pred = st.args[i], value = st.args[i + 1];
            if (!phiIn.has(pred)) phiIn.set(pred, []);
            phiIn.get(pred).push({ tmp: st.tmp, value });
          }
        }
      }
    }
  }
  for (const name of tempType.keys()) allocLocal(name, tempType.get(name));

  // CFG
  const preds = new Map(), succs = new Map();
  for (const b of fn.blocks) { preds.set(b.label, []); succs.set(b.label, []); }
  for (const b of fn.blocks) {
    for (const st of b.stmts) {
      if (st.kind === "jnz") { succs.get(b.label).push(st.t, st.f); preds.get(st.t).push(b.label); preds.get(st.f).push(b.label); }
      else if (st.kind === "jmp") { succs.get(b.label).push(st.target); preds.get(st.target).push(b.label); }
    }
  }
  // fall-through edges: blocks ending without a terminator continue to the next block
  for (let k = 0; k < fn.blocks.length; k++) {
    const b = fn.blocks[k];
    const last = b.stmts[b.stmts.length - 1];
    const term = last && (last.kind === "jnz" || last.kind === "jmp" || last.kind === "ret");
    if (!term && k + 1 < fn.blocks.length) {
      succs.get(b.label).push(fn.blocks[k + 1].label);
      preds.get(fn.blocks[k + 1].label).push(b.label);
    }
  }
  const visited = new Set(), rpo = [];
  const dfs = (l) => {
    if (visited.has(l)) return;
    visited.add(l);
    for (const s of succs.get(l) || []) dfs(s);
    rpo.push(l);
  };
  dfs(fn.blocks[0].label);
  rpo.reverse();
  const rpoIdx = new Map(rpo.map((l, i) => [l, i]));
  // the IR's implicit fall-through successor = the next block in file order
  const fallOf = (l) => {
    for (let k = 0; k < fn.blocks.length; k++) if (fn.blocks[k].label === l) return (fn.blocks[k + 1] || {}).label;
    return undefined;
  };

  // back edges (target earlier in RPO and reachable from source)
  const backEdgeTarget = new Map();   // src → loop header label
  const loopHeaders = new Set();
  for (const b of fn.blocks) {
    for (const s of succs.get(b.label) || []) {
      if (s !== b.label && rpoIdx.get(s) < rpoIdx.get(b.label)) {
        const reach = (from, seen) => {
          if (from === s) return true;
          if (seen.has(from)) return false;
          seen.add(from);
          return (succs.get(from) || []).some((x) => reach(x, seen));
        };
        if (reach(b.label, new Set())) {
          backEdgeTarget.set(b.label, s);
          loopHeaders.add(s);
        }
      }
    }
  }
  // loop bodies + exits (blocks that can get back to the header)
  const loopBody = new Map(), loopExit = new Map();
  for (const h of loopHeaders) {
    const reach = new Set([h]);
    const stack = [h];
    while (stack.length) {
      const l = stack.pop();
      for (const x of succs.get(l) || []) {
        if (backEdgeTarget.get(l) === x) continue;   // don't cross the back edge
        if (!reach.has(x)) { reach.add(x); stack.push(x); }
      }
    }
    const canReach = (from, seen) => {
      if (from === h) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (succs.get(from) || []).some((x) => canReach(x, seen));
    };
    const body = new Set([h]);
    for (const l of reach) if (l !== h && canReach(l, new Set())) body.add(l);
    loopBody.set(h, body);
    const exits = new Set();
    for (const l of body) for (const x of succs.get(l) || []) if (!body.has(x)) exits.add(x);
    loopExit.set(h, exits);
  }

  // structured emission
  const structStack = [];   // {kind, header?, exitSet?}
  const emitted = new Set();
  let loopId = 0;
  const brTo = (structIdx) => emit(OP.br, uleb(structStack.length - 1 - structIdx));

  const wasmOf = (t) => QBE_TYPE_TO_WASM[t] ?? I32;

  const pushOperand = (op, expect) => {
    if (op.startsWith("%")) {
      const idx = localIdx.get(op);
      const actual = wasmOf(tempType.get(op));
      emit(OP.local_get, uleb(idx));
      if (expect === I32 && actual === I64) emit(OP.i32_wrap_i64);
      else if (expect === I64 && actual === I32) emit(OP.i64_extend_i32_s);
      else if (expect === S && actual === D) emit(OP.f32_demote_f64);
      else if (expect === D && actual === S) emit(OP.f64_promote_f32);
      else if (expect && expect !== actual && actual !== undefined)
        throw new Error(`qbe: type mismatch ${op} (${actual}) for ${expect}`);
      return;
    }
    if (FLOAT_RE.test(op)) {
      const d = parseFloat(op.slice(2));
      if (op[0] === "s") { const b = new Uint8Array(new Float32Array([d]).buffer); emit(OP.f32_const, ...b); }
      else { const b = new Uint8Array(new Float64Array([d]).buffer); emit(OP.f64_const, ...b); }
      return;
    }
    if (/^-?\d*\.\d/.test(op) || /^-?\d+[eE]/.test(op)) {
      const d = parseFloat(op);
      const b = new Uint8Array(new Float64Array([d]).buffer);
      emit(OP.f64_const, ...b);
      return;
    }
    if (op.startsWith("$")) {
      const off = mod.dataOffset.get(op);
      if (off === undefined) throw new Error(`qbe: undefined data symbol ${op}`);
      if (wasm64) emit(OP.i64_const, sleb(BigInt(off)));
      else {
        emit(OP.i32_const, uleb(off));
        if (expect === I64) emit(OP.i64_extend_i32_u);
      }
      return;
    }
    const n = BigInt(op);
    if (expect === I64) emit(OP.i64_const, sleb(BigInt.asIntN(64, n)));
    else emit(OP.i32_const, sleb(BigInt.asIntN(32, n)));
  };

  const binOp = (q) => ({
    add: [OP.i32_add, OP.i64_add], sub: [OP.i32_sub, OP.i64_sub], mul: [OP.i32_mul, OP.i64_mul],
    div: [OP.i32_div_s, OP.i64_div_s], udiv: [OP.i32_div_u, OP.i64_div_u],
    rem: [OP.i32_rem_s, OP.i64_rem_s], urem: [OP.i32_rem_u, OP.i64_rem_u],
    and: [OP.i32_and, OP.i64_and], or: [OP.i32_or, OP.i64_or], xor: [OP.i32_xor, OP.i64_xor],
    shl: [OP.i32_shl, OP.i64_shl], shr: [OP.i32_shr_u, OP.i64_shr_u], sar: [OP.i32_shr_s, OP.i64_shr_s],
  }[q]);
  const cmpOp = (q) => ({
    ceqw: [OP.i32_eq, I32], cnew: [OP.i32_ne, I32], ceql: [OP.i64_eq, I64], cnel: [OP.i64_ne, I64],
    csltw: [OP.i32_lt_s, I32], cslew: [OP.i32_le_s, I32], csgtw: [OP.i32_gt_s, I32], csgew: [OP.i32_ge_s, I32],
    cultw: [OP.i32_lt_u, I32], culew: [OP.i32_le_u, I32], cugtw: [OP.i32_gt_u, I32], cugew: [OP.i32_ge_u, I32],
    csltl: [OP.i64_lt_s, I64], cslel: [OP.i64_le_s, I64], csgtl: [OP.i64_gt_s, I64], csgel: [OP.i64_ge_s, I64],
    cultl: [OP.i64_lt_u, I64], culel: [OP.i64_le_u, I64], cugtl: [OP.i64_gt_u, I64], cugel: [OP.i64_ge_u, I64],
    ceqs: [OP.f32_eq, S], cnes: [OP.f32_ne, S], clts: [OP.f32_lt, S], cles: [OP.f32_le, S], cgts: [OP.f32_gt, S], cges: [OP.f32_ge, S],
    ceqd: [OP.f64_eq, D], cned: [OP.f64_ne, D], cltd: [OP.f64_lt, D], cled: [OP.f64_le, D], cgtd: [OP.f64_gt, D], cged: [OP.f64_ge, D],
  }[q]);
  const convOp = (q) => ({
    extsb: [OP.i32_extend8_s, I32], extub: [OP.i32_extend8_u, I32], extsh: [OP.i32_extend16_s, I32], extuh: [OP.i32_extend16_u, I32],
    extsw: [OP.i64_extend_i32_s, I32], extuw: [OP.i64_extend_i32_u, I32],
    stosi: [OP.i32_trunc_f32_s, S], stoui: [OP.i32_trunc_f32_u, S], stoli: [OP.i64_trunc_f32_s, S], stouli: [OP.i64_trunc_f32_u, S],
    dtosi: [OP.i32_trunc_f64_s, D], dtoui: [OP.i32_trunc_f64_u, D], dtoli: [OP.i64_trunc_f64_s, D], dtouli: [OP.i64_trunc_f64_u, D],
    itos: [OP.f32_convert_i32_s, I32], uitos: [OP.f32_convert_i32_u, I32], ltos: [OP.f32_convert_i64_s, I64], ultos: [OP.f32_convert_i64_u, I64],
    itod: [OP.f64_convert_i32_s, I32], uitod: [OP.f64_convert_i32_u, I32], ltod: [OP.f64_convert_i64_s, I64], ultod: [OP.f64_convert_i64_u, I64],
  }[q]);
  const cvtMap = {
    stod: OP.f64_promote_f32, dtos: OP.f32_demote_f64,
    stow: OP.i32_trunc_f32_s, stol: OP.i64_trunc_f32_s, utow: OP.i32_trunc_f32_u, utol: OP.i64_trunc_f32_u,
    dtow: OP.i32_trunc_f64_s, dtol: OP.i64_trunc_f64_s, utow: OP.i32_trunc_f64_u, utol: OP.i64_trunc_f64_u,
  };
  const loadOp = (q) => ({ loadub: OP.i32_load8_u, loadsb: OP.i32_load8_s, loaduh: OP.i32_load16_u, loadsh: OP.i32_load16_s,
    loadw: OP.i32_load, loadl: OP.i64_load, loads: OP.f32_load, loadd: OP.f64_load }[q]);
  const loadAlign = (q) => ({ loadub: 0, loadsb: 0, loaduh: 1, loadsh: 1, loadw: 2, loadl: 3, loads: 2, loadd: 3 }[q]);
  const storeOp = (q) => ({ storeb: OP.i32_store8, storeh: OP.i32_store16, storew: OP.i32_store,
    storel: OP.i64_store, stores: OP.f32_store, stored: OP.f64_store }[q]);
  const storeAlign = (q) => ({ storeb: 0, storeh: 1, storew: 2, storel: 3, stores: 2, stored: 3 }[q]);

  const SP = 0;
  const stackBase = mod.stackSize;

  const allocN = (size, align) => {
    const aligned = Math.ceil(size / align) * align;
    emit(OP.global_get, uleb(SP));          // result = old sp (pushed)
    if (wasm64) {
      emit(OP.i64_const, sleb(BigInt(aligned)));
      emit(OP.global_get, uleb(SP));
      emit(OP.i64_add);
      emit(OP.global_set, uleb(SP));
    } else {
      emit(OP.i32_const, uleb(aligned));
      emit(OP.global_get, uleb(SP));
      emit(OP.i32_add);
      emit(OP.global_set, uleb(SP));
      emit(OP.i64_extend_i32_u);            // l result
    }
  };

  const emitPhiStores = (predLabel) => {
    const ins = phiIn.get(predLabel);
    if (!ins) return;
    for (const { tmp, value } of ins) {
      pushOperand(value, wasmOf(tempType.get(tmp)));
      emit(OP.local_set, uleb(localIdx.get(tmp)));
    }
  };

  const emitStmt = (st) => {
    if (st.kind === "op" && st.op === "call") {
      for (const a of st.args) pushOperand(a.value, wasmOf(a.type));
      const fi = mod.funcIdx.get(st.fname);
      if (fi === undefined) throw new Error(`qbe: unknown function ${st.fname}`);
      emit(OP.call, uleb(fi));
      if (st.tmp) emit(OP.local_set, uleb(localIdx.get(st.tmp)));
      return;
    }
    if (st.kind === "op") {
      const idx = st.tmp ? localIdx.get(st.tmp) : null;
      const ty = st.type;
      switch (st.op) {
        case "alloc1": case "alloc2": case "alloc4": case "alloc8": case "alloc16":
          allocN(Number(st.args[0]) || 0, Number(st.op.slice(5)) || 1);
          emit(OP.local_set, uleb(idx));
          return;
        case "loadub": case "loadsb": case "loaduh": case "loadsh": case "loadw": case "loadl": case "loads": case "loadd":
          pushOperand(st.args[0], PTR);
          emit(loadOp(st.op), memarg(loadAlign(st.op)));
          emit(OP.local_set, uleb(idx));
          return;
        case "copy":
          pushOperand(st.args[0], wasmOf(ty));
          emit(OP.local_set, uleb(idx));
          return;
        case "phi":
          return;
        case "blit":
          for (const a of st.args) pushOperand(a, PTR);
          emit(0xfc, 0x0a, 0x00, 0x00);   // memory.copy
          return;
      }
      if (st.op === "vaarg" || st.op === "vastart") throw new Error("qbe: varargs unsupported");
      if (st.op === "hlt") { emit(0x00); return; }  // unreachable
      if (st.op === "neg") {
        pushOperand(st.args[0], wasmOf(ty));
        if (ty === "s") emit(OP.f32_neg);
        else if (ty === "d") emit(OP.f64_neg);
        else {
          // int neg: 0 - x
          emit(ty === "l" ? OP.i64_const : OP.i32_const, ty === "l" ? sleb(0n) : uleb(0));
          pushOperand(st.args[0], wasmOf(ty));
          emit(ty === "l" ? OP.i64_sub : OP.i32_sub);
        }
        emit(OP.local_set, uleb(idx));
        return;
      }
      if (st.op === "abs") {
        pushOperand(st.args[0], wasmOf(ty));
        emit(ty === "s" ? OP.f32_abs : OP.f64_abs);
        emit(OP.local_set, uleb(idx));
        return;
      }
      if (st.op === "sqrt") {
        pushOperand(st.args[0], wasmOf(ty));
        emit(ty === "s" ? OP.f32_sqrt : OP.f64_sqrt);
        emit(OP.local_set, uleb(idx));
        return;
      }
      if (st.op === "cvt") {
        const a0 = st.args[0];
        let key, val;
        if (a0 && cvtMap[a0] !== undefined) { key = a0; val = st.args[1]; }
        else { key = a0 + "to" + st.args[1]; val = st.args[2]; }
        const opc = cvtMap[key];
        if (opc === undefined) throw new Error(`qbe: unsupported cvt ${key}`);
        pushOperand(val, wasmOf(st.type));
        emit(opc);
        emit(OP.local_set, uleb(idx));
        return;
      }
      const b = binOp(st.op);
      if (b) {
        const expect = ty === "l" ? I64 : ty === "s" || ty === "d" ? (ty === "s" ? S : D) : I32;
        pushOperand(st.args[0], expect);
        pushOperand(st.args[1], expect);
        if (expect === I32) emit(b[0]);
        else if (expect === I64) emit(b[1]);
        else emit(expect === S ? { [OP.i32_add]: OP.f32_add, [OP.i32_sub]: OP.f32_sub, [OP.i32_mul]: OP.f32_mul, [OP.i32_div_s]: OP.f32_div }[b[0]] : { [OP.i32_add]: OP.f64_add, [OP.i32_sub]: OP.f64_sub, [OP.i32_mul]: OP.f64_mul, [OP.i32_div_s]: OP.f64_div }[b[0]]);
        emit(OP.local_set, uleb(idx));
        return;
      }
      const c = cmpOp(st.op);
      if (c) {
        pushOperand(st.args[0], c[1]);
        pushOperand(st.args[1], c[1]);
        emit(c[0]);
        emit(OP.local_set, uleb(idx));
        return;
      }
      const cv = convOp(st.op);
      if (cv) {
        pushOperand(st.args[0], cv[1]);
        emit(cv[0]);
        emit(OP.local_set, uleb(idx));
        return;
      }
      throw new Error(`qbe: unsupported op '${st.op}'`);
    }
    if (st.kind === "store") {
      const stTy = storeTypeOf(st.op);
      // wasm stores pop [value, addr]: push addr first, then value
      pushOperand(st.ptr, PTR);
      pushOperand(st.value, stTy);
      emit(storeOp(st.op), memarg(storeAlign(st.op)));
      return;
    }
    throw new Error(`qbe: unexpected statement`);
  };

  const storeTypeOf = (q) => ({ storeb: I32, storeh: I32, storew: I32, storel: I64, stores: S, stored: D }[q]);

  // ── control flow lowering ──
  const openExits = () => {
    const s = new Set();
    for (const e of structStack) if (e.exitSet) for (const x of e.exitSet) s.add(x);
    return s;
  };
  const openLoopAt = (header) => {
    for (let i = structStack.length - 1; i >= 0; i--)
      if (structStack[i].kind === "loop" && structStack[i].header === header) return structStack[i];
    return null;
  };

  const reachFwd = (l, seen = new Set()) => {
    if (seen.has(l)) return seen;
    seen.add(l);
    const b = blockByName.get(l);
    if (!b) return seen;
    const last = b.stmts[b.stmts.length - 1];
    const isTerm = last && (last.kind === "ret" || last.kind === "jmp" || last.kind === "jnz");
    if (!isTerm) {
      const nxt = fallOf(l);
      if (nxt) reachFwd(nxt, seen);
    } else if (last.kind === "jmp") {
      if (!backEdgeTarget.has(l)) reachFwd(last.target, seen);
    } else if (last.kind === "jnz") {
      if (!backEdgeTarget.has(l)) { reachFwd(last.t, seen); reachFwd(last.f, seen); }
    }
    return seen;
  };

  const armLoopsBack = (l) => {
    if (emitted.has(l)) return true;   // already-emitted start = the loop header itself
    const reach = reachFwd(l);
    for (const x of reach) if (backEdgeTarget.has(x)) return true;
    return false;
  };

  const retInfo = (l) => {
    // does the chain starting at l end in ret (before any join)?
    const seen = new Set();
    let cur = l;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if ((preds.get(cur) || []).length >= 2) return false;  // hit a join — not a ret arm
      const b = blockByName.get(cur);
      const last = b.stmts[b.stmts.length - 1];
      if (!last) { cur = fallOf(cur); continue; }
      if (last.kind === "ret") return true;
      if (last.kind === "jmp") { cur = last.target; continue; }
      return false;
    }
    return false;
  };

  const nextUnemitted = (from) => {
    for (let i = rpoIdx.get(from) + 1; i < rpo.length; i++)
      if (!emitted.has(rpo[i])) return rpo[i];
    return undefined;
  };

  let activeLoopHeader = null;   // header currently being emitted by emitLoop

  function emitLoop(header, stop) {
    const exits = loopExit.get(header);
    structStack.push({ kind: "block", exitSet: exits });
    emit(OP.block, VOID);
    structStack.push({ kind: "loop", header, exitSet: exits });
    emit(OP.loop, VOID);
    const prev = activeLoopHeader;
    activeLoopHeader = header;
    emitRegion(header, new Set([...stop, ...exits]));
    activeLoopHeader = prev;
    emit(OP.end);
    structStack.pop();
    emit(OP.end);
    structStack.pop();
  }

  const brToExit = () => {
    for (let i = structStack.length - 1; i >= 0; i--) {
      if (structStack[i].kind === "block" && structStack[i].exitSet) {
        emit(OP.br, uleb(structStack.length - 1 - i));
        return;
      }
    }
    throw new Error("qbe: exit without enclosing loop block");
  };

  const emitExitArm = (start, stop) => {
    // the non-looping arm of a loop jnz: run its chain (usually nothing — the
    // exit block is in stop), then branch to the post-loop code.
    emitRegion(start, stop);
    brToExit();
  };

  function emitArm(start, stop) {
    // one arm of a jnz. If the arm starts at an already-emitted block it is the
    // loop-continue (back edge), so branch back to the innermost open loop.
    if (emitted.has(start)) {
      for (let i = structStack.length - 1; i >= 0; i--) {
        if (structStack[i].kind === "loop") { emit(OP.br, uleb(structStack.length - 1 - i)); return; }
      }
      throw new Error("qbe: loop arm without open loop");
    }
    emitRegion(start, stop);
  }

  function emitRegion(start, stop) {
    let l = start;
    while (l !== undefined && !stop.has(l) && !emitted.has(l)) {
      if (activeLoopHeader !== l && loopHeaders.has(l)) { emitLoop(l, stop); l = nextUnemitted(l); continue; }
      const b = blockByName.get(l);
      emitted.add(l);
      for (const st of b.stmts) {
        if (st.kind === "op" && st.op === "phi") continue;
        if (st.kind === "ret" || st.kind === "jnz" || st.kind === "jmp" || st.kind === "hlt") continue;
        emitStmt(st);
      }
      emitPhiStores(l);
      const last = b.stmts[b.stmts.length - 1];
      const term = last && (last.kind === "jnz" || last.kind === "jmp" || last.kind === "ret") ? last : null;
      if (!term) { l = fallOf(l); continue; }
      if (term.kind === "ret") {
        if (term.value !== null) pushOperand(term.value, wasmOf(fn.retType));
        else if (fn.retType !== "v") {
          // dead bare ret in a typed function — emit a default value
          const t = wasmOf(fn.retType);
          if (t === I64) emit(OP.i64_const, sleb(0));
          else if (t === S) { emit(OP.f32_const, 0, 0, 0, 0); }
          else if (t === D) { emit(OP.f64_const, 0, 0, 0, 0, 0, 0, 0, 0); }
          else emit(OP.i32_const, uleb(0));
        }
        emit(OP.return_);
        return "dead";
      }
      if (term.kind === "jmp") {
        const t = term.target;
        if (stop.has(t)) return "live";
        const openLp = openLoopAt(t);
        if (openLp) { brTo(openLp._idx || structStack.indexOf(openLp)); return "dead"; }
        if (openExits().has(t)) {
          // jump to an enclosing loop's exit block
          for (let i = structStack.length - 1; i >= 0; i--)
            if (structStack[i].exitSet && structStack[i].exitSet.has(t)) { emit(OP.br, uleb(structStack.length - 1 - i)); break; }
          return "dead";
        }
        if (loopHeaders.has(t) && !emitted.has(t)) { l = t; continue; }  // jump into a loop
        l = t;   // forward jump — continue the chain
        continue;
      }
      if (term.kind === "jnz") {
        const c = term.cond, T = term.t, F = term.f;
        const Tloops = armLoopsBack(T), Floops = armLoopsBack(F);
        const Tret = retInfo(T), Fret = retInfo(F);
        if (Tloops || Floops) {
          // loop / break / continue jnz: if (c) { armT } else { armF }. The
          // looping arm ends in br $loop; the exit arm ends in br $exit and the
          // post-loop code is emitted after the block by the caller.
          pushOperand(c, I32);
          emit(OP.if_, VOID);
          structStack.push({ kind: "if" });
          if (Tloops) emitArm(T, stop);
          else emitExitArm(T, stop);
          emit(OP.else_);
          if (Floops) emitArm(F, stop);
          else emitExitArm(F, stop);
          emit(OP.end);
          structStack.pop();
          l = nextUnemitted(l);
          continue;
        }
        if (Tret && Fret) {
          pushOperand(c, I32);
          emit(OP.if_, VOID);
          structStack.push({ kind: "if" });
          emitRegion(T, stop);
          emit(OP.else_);
          emitRegion(F, stop);
          emit(OP.end);
          structStack.pop();
          emit(0x00);   // unreachable: both arms returned/branched
          l = nextUnemitted(l);
          return "dead";
        }
        if (Tret) {
          pushOperand(c, I32);
          emit(OP.if_, VOID);
          structStack.push({ kind: "if" });
          emitRegion(T, stop);
          emit(OP.end);
          structStack.pop();
          l = F;
          continue;
        }
        if (Fret) {
          pushOperand(c, I32);
          emit(OP.if_, VOID);
          structStack.push({ kind: "if" });
          const tState = emitRegion(T, stop);
          emit(OP.else_);
          emitRegion(F, stop);
          emit(OP.end);
          structStack.pop();
          if (tState === "dead") emit(0x00);
          l = nextUnemitted(l);
          continue;
        }
        // join case
        const rT = reachFwd(T), rF = reachFwd(F);
        let J = null;
        for (const x of rpo) {
          if (rT.has(x) && rF.has(x)) { J = x; break; }
        }
        if (J === null) throw new Error(`qbe: unsupported control flow at ${l} (no join)`);
        pushOperand(c, I32);
        emit(OP.if_, VOID);
        structStack.push({ kind: "if" });
        emitRegion(T, new Set([...stop, J]));
        emit(OP.else_);
        emitRegion(F, new Set([...stop, J]));
        emit(OP.end);
        structStack.pop();
        l = J;
        continue;
      }
    }
    return "live";
  }

  emitRegion(fn.blocks[0].label, new Set());
  return { locals, code: bytes(code) };  // final `end` added by the module builder
}

// ─── module builder ─────────────────────────────────────────────

export function qbe2wasm(irText, { importBase = "env", wasm64 = false } = {}) {
  const mod = parseIr(irText);
  mod.wasm64 = !!wasm64;

  // data segments → bytes with alignment
  const dataBytes = [];
  const dataOffset = new Map();
  const symbolStart = new Map();
  const unescape = (s) => {
    let out = "", i = 1;
    const body = s.slice(1, -1);
    for (let k = 0; k < body.length; k++) {
      const ch = body[k];
      if (ch === "\\") {
        const d = body[k + 1];
        if (d === "n") { out += "\n"; k++; }
        else if (d === "t") { out += "\t"; k++; }
        else if (d === "\\") { out += "\\"; k++; }
        else if (d === '"') { out += '"'; k++; }
        else if (d >= "0" && d <= "7") {
          let val = 0, cnt = 0;
          while (cnt < 3 && body[k + 1] >= "0" && body[k + 1] <= "7") { val = val * 8 + (body[k + 1] - "0"); k++; cnt++; }
          out += String.fromCharCode(val);
        } else out += ch;
      } else out += ch;
    }
    return out;
  };
  const alignOf = (t) => ({ b: 1, h: 2, w: 4, l: 8, s: 4, d: 8 }[t] || 1);
  const emitBytes = (arr) => { for (const x of arr) dataBytes.push(x & 0xff); };
  const pad = (n) => { while (dataBytes.length % n !== 0) dataBytes.push(0); };

  for (const d of mod.data) {
    if (symbolStart.has(d.name)) continue;
    symbolStart.set(d.name, dataBytes.length);
    for (const item of d.items) {
      const a = alignOf(item.type);
      pad(a);
      const v = item.value;
      if (item.type === "z") { for (let i = 0; i < Number(v); i++) dataBytes.push(0); continue; }
      if (item.type === "b") {
        if (v.startsWith('"')) emitBytes([...unescape(v)].map((c) => c.charCodeAt(0) & 0xff));
        else emitBytes([Number(v) & 0xff]);
        continue;
      }
      if (item.type === "s" || item.type === "d") {
        const dd = parseFloat(v);
        emitBytes(item.type === "s" ? new Uint8Array(new Float32Array([dd]).buffer) : new Uint8Array(new Float64Array([dd]).buffer));
        continue;
      }
      const n = BigInt(v);
      if (item.type === "h") emitBytes([Number(n & 0xffffn), Number((n >> 8n) & 0xffn)]);
      else if (item.type === "w") emitBytes([Number(n & 0xffn), Number((n >> 8n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 24n) & 0xffn)]);
      else if (item.type === "l") for (let i = 0; i < 8; i++) emitBytes([Number((n >> BigInt(8 * i)) & 0xffn)]);
    }
  }
  for (const [name, off] of symbolStart) dataOffset.set(name, off);
  mod.dataOffset = dataOffset;

  // stack pointer: module-level global index 0, starts after the static data
  mod.stackSize = (dataBytes.length + 15) & ~15;

  // function signatures
  const typeSection = [];
  const typeIdx = new Map();
  const sigOf = (params, ret) => {
    const key = (params || []).map((p) => p.type || "v").join("") + "->" + (ret || "v");
    if (!typeIdx.has(key)) {
      typeIdx.set(key, typeSection.length);
      typeSection.push({ params: (params || []).map((p) => QBE_TYPE_TO_WASM[p.type] ?? VOID), ret: QBE_TYPE_TO_WASM[ret] ?? VOID });
    }
    return typeIdx.get(key);
  };

  const defined = new Set(mod.funcs.map((f) => f.name));
  const imports = [];
  const importBySym = new Map();
  for (const fn of mod.funcs) {
    for (const b of fn.blocks) for (const st of b.stmts) {
      if (st.kind === "op" && st.op === "call" && st.extern && !defined.has(st.fname) && !importBySym.has(st.fname)) {
        const sig = sigOf(st.args.map((a) => ({ type: a.type })), st.type);
        importBySym.set(st.fname, imports.length);
        imports.push({ name: st.fname, sig });
      }
    }
  }

  const finalIdx = new Map();
  imports.forEach((imp, i) => finalIdx.set(imp.name, i));
  let fidx = imports.length;
  for (const fn of mod.funcs) if (!finalIdx.has(fn.name)) finalIdx.set(fn.name, fidx++);
  mod.funcIdx = finalIdx;

  const functions = [];
  for (const fn of mod.funcs) {
    const ti = sigOf(fn.params, fn.retType);
    const gen = genFunction(fn, mod);
    // local decls: count runs of declared (non-param) locals by type
    const decls = gen.locals.slice(fn.params.length);
    const runs = [];
    for (const d of decls) {
      const t = QBE_TYPE_TO_WASM[d.type] ?? I32;
      if (runs.length && runs[runs.length - 1][0] === t) runs[runs.length - 1][1]++;
      else runs.push([t, 1]);
    }
    const inner = bytes(
      uleb(runs.length),
      ...runs.flatMap(([t, n]) => bytes(uleb(n), [t])),
      gen.code, OP.end,
    );
    functions.push({ ti, body: bytes(...uleb(inner.length), inner) });
  }

  // assemble
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const sections = [];
  // sec: payload = uleb(items.length) + flattened items; section = id + uleb(len) + payload
  const sec = (id, items) => {
    const payload = bytes(uleb(items.length), items);
    sections.push(bytes(id, ...uleb(payload.length), payload));
  };

  sec(1, typeSection.map((t) => bytes(0x60, ...vec(t.params.map((p) => [p])), ...vec(t.ret === VOID ? [] : [t.ret]))));
  if (imports.length) {
    sec(2, imports.map((imp) => bytes(
      ...vec(strBytes(importBase)), ...vec(strBytes(imp.name)),
      0x00, ...uleb(imp.sig),
    )));
  }
  sec(3, functions.map((f) => uleb(f.ti)));
  const pages = Math.max(1, Math.ceil((mod.stackSize + 65536) / 65536));
  if (wasm64) {
    // (memory i64 N): limits flags 0x04, min as u64
    sec(5, [bytes(0x04, ...uleb(pages))]);
    sec(6, [bytes(I64, 0x01, OP.i64_const, ...sleb(BigInt(mod.stackSize)), OP.end)]);
  } else {
    sec(5, [bytes(0x00, ...uleb(pages))]);
    sec(6, [bytes(0x7f, 0x01, OP.i32_const, ...uleb(mod.stackSize), OP.end)]);
  }
  const exports = [];
  for (const fn of mod.funcs) if (fn.exported) exports.push([fn.name, 0x00, finalIdx.get(fn.name)]);
  exports.push(["memory", 0x02, 0]);
  if (exports.length) sec(7, exports.map(([name, kind, idx]) => bytes(...vec(strBytes(name)), kind, ...uleb(idx))));
  sec(10, functions.map((f) => f.body));
  if (dataBytes.length) {
    const offExpr = wasm64 ? bytes(0x42, 0x00, 0x0b) : bytes(0x41, 0x00, 0x0b);
    sec(11, [bytes(0x00, ...offExpr, ...vec(dataBytes))]);
  }

  return new Uint8Array(bytes(header, ...sections));
}

export { parseIr };
