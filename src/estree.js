// ─── estree: ESTree JSON → JavaScript source ────────────────────
//
// debashl emits standard ESTree (PLAN.md §1.2) with shell semantics
// lowered to calls into the `sh2.*` runtime. This emitter renders that
// tree back to JS source, which the shell then runs with the `sh2`
// runtime in scope. The node set debashl emits is small and regular:
//
//   Program, ExpressionStatement, BlockStatement, IfStatement,
//   SwitchStatement, SwitchCase, BreakStatement, LogicalExpression,
//   CallExpression, MemberExpression, Identifier, Literal,
//   ArrayExpression, ObjectExpression, Property, AwaitExpression,
//   ArrowFunctionExpression, TemplateLiteral, TemplateElement
// -----------------------------------------------------------------

// The debashl estree is STANDARD ESTree (16 node types), so a real
// estree→JS generator — astring (single file, MIT, vendored at
// www/vendor/astring.mjs) — replaces the hand-rolled emitter below. It
// handles every node type (no "unsupported statement" gaps), including
// ForStatement/ForOfStatement/SequenceExpression and the sh2.* calls.
const astringCache = new Map();   // module url → { generate }
let astringUrl = null;
async function getAstring() {
  if (astringCache.has(astringUrl)) return astringCache.get(astringUrl);
  const url = new URL("../www/vendor/astring.mjs", import.meta.url).href;
  const mod = await import(url);
  astringUrl = url;
  astringCache.set(url, mod);
  return mod;
}

export async function estreeToJs(program) {
  return (await estreeToJsMapped(program, null, null)).js;
}

// ─── stripProcessEnv: make the generated code process-free ──────────
// The otranspilerl estree backend renders store-read fallbacks as
// `sh2.vars.x ?? (process.env.x ?? "")`. `process` is a parameter of the
// eval scopes that RUN a program, but a sourced C function is CALLED
// later from the shell's native dispatch — where `process` may not be a
// global (browser) — so evaluating the fallback throws "process is not
// defined". Rewrite every `process.env.<x>` member chain to `sh2.env.<x>`
// (the runtime facade exposes the shell env) — same semantics, no
// `process` reference anywhere.
function stripProcessEnv(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(stripProcessEnv);
  // process.env.<name>  /  process.env  (the env member access itself)
  if (node.type === "MemberExpression") {
    if (node.object && node.object.type === "Identifier" && node.object.name === "process" &&
        node.property && node.property.type === "Identifier" && node.property.name === "env") {
      return { ...node, object: { type: "Identifier", name: "sh2" } };
    }
    if (node.object && node.object.type === "MemberExpression" &&
        node.object.object && node.object.object.type === "Identifier" && node.object.object.name === "process" &&
        node.object.property && node.object.property.type === "Identifier" && node.object.property.name === "env") {
      return { ...node, object: { ...node.object, object: { type: "Identifier", name: "sh2" } } };
    }
  }
  const out = {};
  for (const k of Object.keys(node)) out[k] = stripProcessEnv(node[k]);
  return out;
}

// A final top-level statement that corresponds to a source statement:
// declaration hoists (`let x = 0`) and lastExit bookkeeping carry no
// source line — everything else maps to an A1 stmt in order.
function isMeaningful(st) {
  if (!st) return false;
  if (st.type === "VariableDeclaration") return false;
  // normalizeFunctions' registration adapter and keepVariables' store-sync
  // are generated artifacts — they must not consume an A1 statement index
  // in the source↔generated line map (the walk assumes the estree
  // statements align 1:1 with the A1 top-level statements).
  if (st._sh2Adapter || st._sh2Sync) return false;
  if (
    st.type === "ExpressionStatement" &&
    st.expression &&
    st.expression.type === "AssignmentExpression" &&
    st.expression.left &&
    st.expression.left.type === "MemberExpression" &&
    st.expression.left.object &&
    st.expression.left.object.name === "sh2"
  ) {
    return false; // sh2.lastExit = N bookkeeping
  }
  return true;
}

// ─── normalizeFunctions: C functions become PLAIN JS functions ──────
// The c-sh-go frontend emits each user function as
//   sh2.functions.set("my_qsort", async () => {
//     base = sh2.positional[0] ?? "";     // positional plumbing
//     ...body full of sh2.vars.* store access...
//   });
// This pass rewrites that into a NORMAL function with real C parameters
// and native locals — the function is directly callable from JS
// (`await my_qsort("a", 4, "cmp")`) — and keeps a tiny adapter in the
// runtime table so bash's positional dispatch still works:
//   async function my_qsort(base, nitems, cmp) { let i = "0", j = "0"; ... }
//   sh2.functions.set("my_qsort", () => my_qsort(sh2.positional[0], ...));
// Only functions whose arrow starts with `p = sh2.positional[N] ?? ""`
// (the c frontend's param protocol) are transformed; bash functions and
// param-less C functions are left as-is. `async` is kept exactly where
// the body awaits a runtime bridge (the comparator dispatch); sync-only
// functions stay plain.
export function normalizeFunctions(program) {
  if (!program || program.type !== "Program") return program;
  const body = program.body || [];

  const isSh2Member = (n, name) =>
    n && n.type === "MemberExpression" && !n.computed &&
    n.object && n.object.type === "Identifier" && n.object.name === "sh2" &&
    n.property && n.property.type === "Identifier" && n.property.name === name;
  const isFunctionsSetCallee = (n) =>
    n && n.type === "MemberExpression" && !n.computed &&
    n.property && n.property.type === "Identifier" && n.property.name === "set" &&
    n.object && n.object.type === "MemberExpression" && !n.object.computed &&
    n.object.object && n.object.object.type === "Identifier" && n.object.object.name === "sh2" &&
    n.object.property && n.object.property.type === "Identifier" && n.object.property.name === "functions";
  const isSh2Vars = (n) =>
    n && n.type === "MemberExpression" && !n.computed &&
    n.object && n.object.type === "MemberExpression" &&
    n.object.object && n.object.object.type === "Identifier" && n.object.object.name === "sh2" &&
    n.object.property && n.object.property.type === "Identifier" && n.object.property.name === "vars" &&
    n.property && n.property.type === "Identifier";
  const litStr = (n) => (n && n.type === "Literal" && typeof n.value === "string" ? n.value : null);

  // 1. locate function-registration statements and their arrows.
  //    shapes:  sh2.functions.set("x", Arrow)
  //             (__fn_x = Arrow, sh2.functions.set("x", __fn_x), true)
  const registrations = []; // { stmt, arrow, fnName, arrowIdx, seqExpr, seqIdx }
  const newBody = [];
  for (const st of body) {
    if (st.type !== "ExpressionStatement") { newBody.push(st); continue; }
    const e = st.expression;
    const seq = e.type === "SequenceExpression" ? e.expressions : null;
    // direct form: sh2.functions.set("x", arrow)
    if (e.type === "CallExpression" && isFunctionsSetCallee(e.callee) &&
        e.arguments && e.arguments[0] && e.arguments[0].type === "Literal" &&
        e.arguments[1] && e.arguments[1].type === "ArrowFunctionExpression") {
      registrations.push({ stmt: st, arrow: e.arguments[1], fnName: String(e.arguments[0].value), seqExpr: e, seqIdx: -1, direct: true });
      newBody.push(st);
      continue;
    }
    // sequence form: (__fn_x = Arrow, sh2.functions.set("x", __fn_x), true)
    if (seq) {
      let arrow = null, fnName = null, arrowIdx = -1, setIdx = -1;
      for (let i = 0; i < seq.length; i++) {
        const x = seq[i];
        if (x.type === "AssignmentExpression" && x.operator === "=" &&
            x.left && x.left.type === "Identifier" && x.left.name.startsWith("__fn_") &&
            x.right && x.right.type === "ArrowFunctionExpression") {
          arrow = x.right; arrowIdx = i;
        }
        if (x.type === "CallExpression" && isFunctionsSetCallee(x.callee) &&
            x.arguments && x.arguments[0] && x.arguments[0].type === "Literal") {
          fnName = String(x.arguments[0].value); setIdx = i;
        }
      }
      if (arrow && fnName) {
        registrations.push({ stmt: st, arrow, fnName, seqExpr: seq, seqIdx: arrowIdx, direct: false });
      }
      newBody.push(st);
      continue;
    }
    newBody.push(st);
  }
  if (!registrations.length) return program;

  // 2. scan the WHOLE program for store-name usage (to decide function-locality)
  const usage = new Map(); // name -> Set of "top" | fnName
  const runtimeByName = new Set(); // names read/written by the runtime via string args (getLine/getVar)
  const walkUsage = (node, owner) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walkUsage(n, owner); return; }
    if (isSh2Vars(node) && node.property.type === "Identifier") {
      const name = node.property.name;
      if (!usage.has(name)) usage.set(name, new Set());
      usage.get(name).add(owner);
    }
    if (node.type === "CallExpression" && node.callee && node.callee.type === "MemberExpression" &&
        node.callee.object && node.callee.object.type === "Identifier" && node.callee.object.name === "sh2" &&
        node.callee.property && node.callee.property.type === "Identifier") {
      const fn = node.callee.property.name;
      const a0 = node.arguments && node.arguments[0];
      if ((fn === "getLine" || fn === "getVar") && a0) {
        const s = litStr(a0);
        if (s && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) runtimeByName.add(s);
        const inner = a0;
        if (inner && inner.type === "TemplateLiteral") {
          const head = (inner.quasis && inner.quasis[0] && inner.quasis[0].value.cooked) || "";
          const m = /^([A-Za-z_][A-Za-z0-9_]*)\[$/.exec(head);
          if (m) runtimeByName.add(m[1]);
        }
      }
    }
    for (const k of Object.keys(node)) walkUsage(node[k], owner);
  };
  walkUsage(program.body, "top");
  for (const r of registrations) {
    // remove the arrow's own body from the "top" scan? — the walkUsage above
    // already counted everything as "top"; re-scan each arrow with its own id
    // and remove it from the top set.
    const walkArrow = (node, owner) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) walkArrow(n, owner); return; }
      if (isSh2Vars(node) && node.property.type === "Identifier") {
        const name = node.property.name;
        const set = usage.get(name);
        if (set) { set.delete("top"); set.add(owner); }
      }
      for (const k of Object.keys(node)) walkArrow(node[k], owner);
    };
    walkArrow(r.arrow, r.fnName);
  }

  // 3. transform each registration with the param protocol
  for (const r of registrations) {
    const block = r.arrow.body;
    if (block.type !== "BlockStatement" || !Array.isArray(block.body)) continue;
    // leading `p = sh2.positional[N] ?? ""` assigns, OR the signature-cast
    // binding `sh2.setVar("p", sh2.arith("$N"))` (an integer param — the
    // glue casts the bash positional to the C type)
    const params = [];
    const body = block.body;
    let idx = 0;
    while (idx < body.length) {
      const s = body[idx];
      if (s.type !== "ExpressionStatement" || !s.expression) break;
      const a = s.expression;
      if (a.type === "CallExpression" && a.callee && a.callee.type === "MemberExpression" &&
          a.callee.object && a.callee.object.type === "Identifier" && a.callee.object.name === "sh2" &&
          a.callee.property && a.callee.property.type === "Identifier" && a.callee.property.name === "setVar" &&
          a.arguments && a.arguments[0] && a.arguments[0].type === "Literal" &&
          a.arguments[1] && a.arguments[1].type === "CallExpression" &&
          a.arguments[1].callee && a.arguments[1].callee.type === "MemberExpression" &&
          a.arguments[1].callee.object && a.arguments[1].callee.object.type === "Identifier" && a.arguments[1].callee.object.name === "sh2" &&
          a.arguments[1].callee.property && a.arguments[1].callee.property.type === "Identifier" && a.arguments[1].callee.property.name === "arith" &&
          a.arguments[1].arguments && a.arguments[1].arguments[0] && a.arguments[1].arguments[0].type === "Literal") {
        const nm = String(a.arguments[0].value);
        const m = /^\$([1-9][0-9]*)$/.exec(String(a.arguments[1].arguments[0].value));
        if (!m) break;
        params.push({ name: nm, n: Number(m[1]) - 1, cast: true });
        idx++;
        continue;
      }
      if (a.type !== "AssignmentExpression" || a.operator !== "=") break;
      // the target: `X = ...` (a lifted identifier) or `sh2.vars.X = ...`
      // (a store write — struct/pointer params render this way)
      let name = null;
      if (a.left.type === "Identifier") {
        name = a.left.name;
      } else if (a.left.type === "MemberExpression" && !a.left.computed &&
                 a.left.object && a.left.object.type === "MemberExpression" && !a.left.object.computed &&
                 a.left.object.object && a.left.object.object.type === "Identifier" && a.left.object.object.name === "sh2" &&
                 a.left.object.property && a.left.object.property.type === "Identifier" && a.left.object.property.name === "vars" &&
                 a.left.property && a.left.property.type === "Identifier") {
        name = a.left.property.name;
      }
      if (!name) break;
      const rr = a.right;
      // unwrap a String(...) store-coercion wrapper around the positional
      const inner = rr && rr.type === "CallExpression" && rr.callee && rr.callee.type === "Identifier" &&
        rr.callee.name === "String" && rr.arguments && rr.arguments[0] ? rr.arguments[0] : rr;
      const pos =
        inner && inner.type === "LogicalExpression" && inner.operator === "??" &&
        inner.left && inner.left.type === "MemberExpression" &&
        inner.left.object && inner.left.object.type === "MemberExpression" &&
        inner.left.object.object && inner.left.object.object.type === "Identifier" && inner.left.object.object.name === "sh2" &&
        inner.left.object.property && inner.left.object.property.type === "Identifier" && inner.left.object.property.name === "positional" &&
        inner.left.computed && inner.left.property && inner.left.property.type === "Literal" &&
        inner.right && inner.right.type === "Literal" && inner.right.value === ""
          ? inner.left : null;
      if (!pos) break;
      const n = Number(pos.property.value);
      if (!Number.isInteger(n)) break;
      params.push({ name, n });
      idx++;
    }
    if (!params.length) continue;          // not the c frontend's protocol
    params.sort((x, y) => x.n - y.n);
    // body statements after the param bindings (the arith-cast bindings are
    // consumed as params too)
    const rest = body.slice(idx);
    const paramNames = new Set(params.map((p) => p.name));

    // function-locals: store vars used ONLY in this arrow, not runtime-written by name
    const locals = new Set();
    for (const name of usage.keys()) {
      if (runtimeByName.has(name)) continue;
      const owners = usage.get(name) || new Set();
      if (owners.size === 1 && owners.has(r.fnName) && !paramNames.has(name)) locals.add(name);
    }
    // a CAST param's body reads are store reads (`sh2.vars.nitems`) — lift
    // them to the native parameter (like the locals). NON-cast params
    // (pointers, strings, fn-ptrs) get the same lift when they aren't
    // runtime-written BY NAME: the leading `vars.p = positional[N]`
    // binding is consumed as the parameter, so the body's `sh2.vars.p`
    // reads (a mem-arena pointer walk through `*p` / `p->member`) must
    // become the native param — a store read would see the value the
    // binding never wrote ("").
    for (const p of params) {
      if (p.cast) { locals.add(p.name); continue; }
      if (!runtimeByName.has(p.name)) locals.add(p.name);
    }

    const paramByPos = new Map(params.filter((p) => !p.cast).map((p) => [p.n, p.name]));
    // rewrite store access → native identifiers inside the body
    const rewrite = (node) => {
      if (!node || typeof node !== "object") return node;
      if (Array.isArray(node)) return node.map(rewrite);
      // `sh2.positional[N] ?? ""` / `String(sh2.positional[N] ?? "")` that
      // names one of THIS function's params → the parameter identifier
      const positionalName = (n) => {
        if (!n || n.type !== "LogicalExpression" || n.operator !== "??") return null;
        const l = n.left;
        if (!l || l.type !== "MemberExpression" || !l.object || l.object.type !== "MemberExpression" ||
            l.object.object || l.object.object.name !== "sh2" || l.object.property || l.object.property.name !== "positional" ||
            !l.computed || !l.property || l.property.type !== "Literal") return null;
        return paramByPos.get(Number(l.property.value)) || null;
      };
      const posWrap = node.type === "CallExpression" && node.callee && node.callee.type === "Identifier" &&
        node.callee.name === "String" && node.arguments && node.arguments.length === 1 ? node.arguments[0] : node;
      const pname = posWrap === node ? positionalName(posWrap) : positionalName(posWrap);
      if (pname) return { type: "Identifier", name: pname };
      // sh2.vars.X ?? (process.env.X ?? "")  /  sh2.vars.X  →  X
      if (isSh2Vars(node) && node.property.type === "Identifier" && locals.has(node.property.name)) {
        return { type: "Identifier", name: node.property.name };
      }
      if (node.type === "LogicalExpression" && node.operator === "??" &&
          node.left && isSh2Vars(node.left) && node.left.property && node.left.property.type === "Identifier" &&
          locals.has(node.left.property.name) &&
          node.right && node.right.type === "LogicalExpression" && node.right.operator === "??" &&
          node.right.left && node.right.left.type === "MemberExpression" &&
          node.right.left.object && node.right.left.object.type === "MemberExpression" &&
          node.right.left.object.object && node.right.left.object.object.type === "Identifier" && node.right.left.object.object.name === "process" &&
          node.right.left.object.property && node.right.left.object.property.type === "Identifier" && node.right.left.object.property.name === "env") {
        return { type: "Identifier", name: node.left.property.name };
      }
      // sh2.vars.X = V  →  X = V
      if (node.type === "AssignmentExpression" && node.operator === "=" &&
          isSh2Vars(node.left) && node.left.property && node.left.property.type === "Identifier" &&
          locals.has(node.left.property.name)) {
        return { type: "AssignmentExpression", operator: "=", left: { type: "Identifier", name: node.left.property.name }, right: rewrite(node.right) };
      }
      // sh2.setVar("X", V)  →  X = V  (simple literal names only — template/array names stay)
      if (node.type === "CallExpression" && node.callee && node.callee.type === "MemberExpression" &&
          node.callee.object && node.callee.object.type === "Identifier" && node.callee.object.name === "sh2" &&
          node.callee.property && node.callee.property.type === "Identifier" && node.callee.property.name === "setVar" &&
          node.arguments && node.arguments[0] && node.arguments[0].type === "Literal" &&
          typeof node.arguments[0].value === "string" &&
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.arguments[0].value) &&
          locals.has(node.arguments[0].value)) {
        return { type: "AssignmentExpression", operator: "=", left: { type: "Identifier", name: node.arguments[0].value }, right: rewrite(node.arguments[1]) };
      }
      const out = {};
      for (const k of Object.keys(node)) out[k] = rewrite(node[k]);
      return out;
    };
    const newRest = rewrite(rest);

    // build the plain function
    const localDecls = [...locals].filter((n) => !paramNames.has(n)).sort();
    const fnBlock = {
      type: "BlockStatement",
      body: [
        ...(localDecls.length ? [{ type: "VariableDeclaration", kind: "let", declarations: localDecls.map((n) => ({ type: "VariableDeclarator", id: { type: "Identifier", name: n }, init: { type: "Literal", value: "", raw: null } })) }] : []),
        ...newRest,
      ],
    };
    const fnExpr = {
      type: "FunctionExpression",
      id: { type: "Identifier", name: r.fnName },
      params: params.map((p) => ({ type: "Identifier", name: p.name })),
      body: fnBlock,
      generator: false,
      expression: false,
      async: !!r.arrow.async,
    };
    const positional = (p) => ({
      type: "MemberExpression", computed: true, optional: false,
      object: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: "positional" } },
      property: { type: "Literal", value: p.n, raw: null },
    });
    const adapter = {
      type: "ArrowFunctionExpression",
      params: [],
      body: {
        type: "CallExpression",
        callee: { type: "Identifier", name: r.fnName },
        arguments: params.map((p) => p.cast
          ? { type: "CallExpression", callee: { type: "Identifier", name: "Number" }, arguments: [positional(p)], optional: false }
          : positional(p)),
        optional: false,
      },
      expression: true,
      async: false,
    };
    const setCall = {
      type: "CallExpression",
      callee: { type: "MemberExpression", computed: false, optional: false, object: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: "functions" } }, property: { type: "Identifier", name: "set" } },
      arguments: [{ type: "Literal", value: r.fnName, raw: null }, adapter],
      optional: false,
    };
    if (r.direct) {
      // sh2.functions.set("x", arrow) → function x(...){...}; sh2.functions.set("x", adapter)
      const pos = newBody.indexOf(r.stmt);
      newBody.splice(pos, 1,
        { type: "FunctionDeclaration", id: { type: "Identifier", name: r.fnName }, params: fnExpr.params, body: fnExpr.body, generator: false, expression: false, async: fnExpr.async },
        Object.assign({ type: "ExpressionStatement", expression: setCall }, { _sh2Adapter: true }));
    } else {
      // (__fn_x = arrow, set("x", __fn_x), true) → (__fn_x = fnExpr, set("x", adapter), true)
      r.seqExpr[r.seqIdx] = { type: "AssignmentExpression", operator: "=", left: r.seqExpr[r.seqIdx].left, right: fnExpr };
      const setIdx = r.seqExpr.findIndex((x) => x.type === "CallExpression" && x.arguments && x.arguments[0] && x.arguments[0].type === "Literal" && String(x.arguments[0].value) === r.fnName);
      if (setIdx >= 0) r.seqExpr[setIdx] = setCall;
    }
  }

  // strip the moved param/local names from the top-level `let` declarations
  const moved = new Set();
  for (const r of registrations) {
    const block = r.arrow.body;
    if (block.type !== "BlockStatement") continue;
    let idx = 0;
    while (idx < block.body.length) {
      const s = block.body[idx];
      if (s.type !== "ExpressionStatement" || !s.expression) break;
      const a = s.expression;
      if (a.type !== "AssignmentExpression" || a.operator !== "=" || a.left.type !== "Identifier") break;
      const rr = a.right;
      const pos = rr && rr.type === "LogicalExpression" && rr.operator === "??" && rr.left && rr.left.type === "MemberExpression" &&
        rr.left.object && rr.left.object.type === "MemberExpression" &&
        rr.left.object.object && rr.left.object.object.type === "Identifier" && rr.left.object.object.name === "sh2" &&
        rr.left.object.property && rr.left.object.property.type === "Identifier" && rr.left.object.property.name === "positional";
      if (!pos) break;
      moved.add(a.left.name);
      idx++;
    }
  }
  if (moved.size) {
    for (const st of newBody) {
      if (st.type === "VariableDeclaration" && st.declarations) {
        st.declarations = st.declarations.filter((d) => !(d.id && d.id.type === "Identifier" && moved.has(d.id.name)));
      }
    }
  }
  program.body = newBody;
  return program;
}

// estreeToJs + a source↔generated LINE MAP: `stmtLines` is the A1
// contract's `stmt_lines` (top-level stmt index → 1-based source line);
// `a1Stmts` is the A1 `stmts` array (for TYPE-aware correspondence —
// the estree hoists all assignments into `let` declarations, so the
// statement ORDER doesn't line up: A1 Assigns map to the declarations,
// every other A1 stmt maps to the meaningful statements, each in order).
// Returns { js, map } where map[i] = { jsStart, jsEnd, sourceLine }.
export async function estreeToJsMapped(program, stmtLines, a1Stmts) {
  const { lowerNativeArrays, hoistLoopLastExit, hoistCommonLastExit, dropDeadFlags, mergeInitAssignments, pushLastExitToEnd } = await import("./lower.js");
  const normalized = normalizeFunctions(stripProcessEnv(program));
  const lowered = lowerNativeArrays(normalized);
  hoistLoopLastExit(lowered);
  hoistCommonLastExit(lowered);
  dropDeadFlags(lowered);
  pushLastExitToEnd(lowered);
  mergeInitAssignments(lowered);
  const { generate } = await getAstring();
  const js = generate(lowered);

  const srcLineOf = new Map();
  for (const e of stmtLines || []) srcLineOf.set(e.stmt, e.line);
  // A1 stmt indices by kind: assigns (folded into declarations) vs the rest
  const ASSIGN_KINDS = new Set(["Assign", "Declare", "DeclareArray"]);
  const a1AssignIdx = [], a1OtherIdx = [];
  (a1Stmts || []).forEach((st, i) => {
    (ASSIGN_KINDS.has(st.type) ? a1AssignIdx : a1OtherIdx).push(i);
  });
  const map = [];
  let line = 1, ai = 0, oi = 0;
  for (const st of lowered.body || []) {
    const one = generate({ type: "Program", body: [st] });
    const n = one.split("\n").filter(Boolean).length;
    let a1Idx = null;
    if (st.type === "VariableDeclaration") {
      if (ai < a1AssignIdx.length) a1Idx = a1AssignIdx[ai++];
    } else if (isMeaningful(st)) {
      if (oi < a1OtherIdx.length) a1Idx = a1OtherIdx[oi++];
    }
    if (a1Idx != null) {
      const sl = srcLineOf.get(a1Idx);
      if (sl) map.push({ jsStart: line, jsEnd: line + n - 1, sourceLine: sl });
    }
    line += n;
  }
  return { js, map };
}

// ─── keepVariables: keep shell-array state in the persistent runtime store ──
// debashl lowers `a=(1 2 3)` to an eval-scoped `let a = [...]` (or drops
// it as a dead store) and emits bare `a[1]` / `a.length` reads — none of
// which survive across REPL lines. This pass (the JS-side KEEP_VARIABLES
// equivalent of the sh2perl native-store fold, applied where debashl
// chose the bare-identifier form):
//   • rewrites bare `a[i]` / `a.length` reads of KNOWN array variables to
//     sh2.arrayIndex("a", i) / sh2.arrayLen("a") — which read the
//     persistent runtime store (so a seeded array survives even when
//     debashl dropped the in-program declaration);
//   • appends `sh2.vars.a = a;` right after each top-level `let a = […];`
//     declaration so the array lands in the store (harvestable cross-line).
// `knownArrays` = persistent array variable names (from the REPL state).
// Loop variables (`for (let i…)`) are nested, not program-body
// declarations, and are left alone.
export function keepVariables(program, knownArrays = []) {
  const known = new Set(knownArrays);
  const id = (name) => ({ type: "Identifier", name });
  const member = (obj, prop) => ({ type: "MemberExpression", object: obj, property: prop, computed: false, optional: false });
  const lit = (v) => ({ type: "Literal", value: v, raw: null });
  const call = (callee, args) => ({ type: "CallExpression", callee, arguments: args, optional: false });
  // debashl's raw form for `a=(1 2 3)` is `sh2.setArray("a", [...])` —
  // lowerNativeArrays later folds that into an eval-scoped `let a = [...]`
  // (unharvestable, and re-declaring a seeded name breaks). Match those
  // calls so known array names can be routed through the runtime store.
  const isSetArray = (node) =>
    node && node.type === "CallExpression" && node.callee &&
    node.callee.type === "MemberExpression" && node.callee.object &&
    node.callee.object.type === "Identifier" && node.callee.object.name === "sh2" &&
    node.callee.property && node.callee.property.type === "Identifier" &&
    node.callee.property.name === "setArray" &&
    node.arguments && node.arguments[0] && node.arguments[0].type === "Literal";
  // collect known array names: persistent state + every setArray in the
  // program (a NEW array assigned this line is also known for its reads)
  const collect = (node) => {
    if (Array.isArray(node)) { for (const n of node) collect(n); return; }
    if (!node || typeof node !== "object") return;
    if (isSetArray(node)) known.add(String(node.arguments[0].value));
    for (const k of Object.keys(node)) collect(node[k]);
  };
  collect(program.body || []);
  // also accept lowered `let a = […]` declarations (other pipelines)
  for (const st of program.body || []) {
    if (st.type === "VariableDeclaration" && st.declarations) {
      for (const d of st.declarations) {
        if (d.id && d.id.type === "Identifier" && d.init && d.init.type === "ArrayExpression") {
          known.add(d.id.name);
        }
      }
    }
  }
  // (no early return: the scalar store-sync at the end must run even for
  // lines with no arrays — a runtime-valued `x=$(cmd)` needs it to persist)
  // rewrite bare `a[i]` / `a.length` reads of KNOWN arrays to
  // sh2.arrayIndex / sh2.arrayLen (they read the persistent store, so a
  // seeded array survives even when debashl dropped the declaration)
  function walk(node) {
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (!node || typeof node !== "object") return;
    if (node.type === "MemberExpression" &&
        node.object && node.object.type === "Identifier" &&
        node.object.name !== "sh2" && node.object.name !== "process" &&
        known.has(node.object.name)) {
      const name = node.object.name;
      if (node.computed) {
        Object.assign(node, {
          type: "CallExpression",
          callee: member(id("sh2"), id("arrayIndex")),
          arguments: [lit(name), node.property],
          optional: false,
        });
        walk(node.arguments);
        return;
      }
      if (node.property && node.property.type === "Identifier" && node.property.name === "length") {
        Object.assign(node, {
          type: "CallExpression",
          callee: member(id("sh2"), id("arrayLen")),
          arguments: [lit(name)],
          optional: false,
        });
        return;
      }
      // WHOLE-array reads: debashl renders `$a` / "${a[@]}" of an
      // in-program `let a = [...]` as the NATIVE `a` (a.join(...),
      // [...a]) — but a sourced C function (fill/sort_ints) mutates the
      // RUNTIME STORE, not the native binding. Route the read through
      // the store so the same-program echo sees the post-call values.
      if (node.property.type === "Identifier" && node.property.name === "join") {
        node.object = call(member(id("sh2"), id("arrayItems")), [lit(name)]);
        walk(node.property);
        return;
      }
    }
    // `[...a]` — a spread of a known array reads the store too
    if (node.type === "SpreadElement" && node.argument &&
        node.argument.type === "Identifier" && known.has(node.argument.name)) {
      node.argument = call(member(id("sh2"), id("arrayItems")), [lit(node.argument.name)]);
      return;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  }
  walk(program.body);
  // convert top-level setArray calls into plain assignments (kept in the
  // sloppy eval's implicit globals → harvestable) + a store sync so
  // arrayIndex/arrayLen reads see the value within the same program.
  // (NOT `let` — a seeded name would re-declare and throw.)
  const out = [];
  for (const st of program.body || []) {
    // `let a = [...]` for a KNOWN array — replace with a plain
    // assignment (sloppy global, harvestable) + a store sync, so
    // arrayItems/arrayIndex reads in the SAME program see the value and
    // a C function's store writes are what the echo reads. NOT `let`:
    // a seeded name would re-declare and throw.
    if (st.type === "VariableDeclaration" && st.declarations && st.declarations.length === 1) {
      const d = st.declarations[0];
      if (d && d.id && d.id.type === "Identifier" && d.init && d.init.type === "ArrayExpression" && known.has(d.id.name)) {
        out.push({
          type: "ExpressionStatement",
          expression: { type: "AssignmentExpression", operator: "=", left: id(d.id.name), right: d.init },
        });
        out.push(Object.assign({
          type: "ExpressionStatement",
          expression: call(member(id("sh2"), id("setArray")), [lit(d.id.name), id(d.id.name)]),
        }, { _sh2Sync: true }));
        continue;
      }
    }
    if (st.type === "ExpressionStatement" && isSetArray(st.expression)) {
      const name = String(st.expression.arguments[0].value);
      const arrExpr = st.expression.arguments[1];
      out.push({
        type: "ExpressionStatement",
        expression: { type: "AssignmentExpression", operator: "=", left: id(name), right: arrExpr },
      });
      out.push(Object.assign({
        type: "ExpressionStatement",
        expression: {
          type: "CallExpression",
          callee: member(id("sh2"), id("setArray")),
          arguments: [lit(name), id(name)],
          optional: false,
        },
      }, { _sh2Sync: true }));
      continue;
    }
    out.push(st);
  }
  program.body = out;
  // runtime-valued SCALAR assignments (`x = $(cmd)` — the RHS is awaited,
  // so the emitter lifted it to a native binding): sync the value into the
  // store (`sh2.setVar("x", x)`) so it survives to the next transpiled
  // line — the shell's A1 harvest only captures literal assignment values.
  const out2 = [];
  for (const st of out) {
    if (st.type === "ExpressionStatement" && st.expression &&
        st.expression.type === "AssignmentExpression" && st.expression.operator === "=" &&
        st.expression.left && st.expression.left.type === "Identifier" &&
        exprHasAwait(st.expression.right)) {
      out2.push(st);
      out2.push(Object.assign({
        type: "ExpressionStatement",
        expression: {
          type: "CallExpression",
          callee: member(id("sh2"), id("setVar")),
          arguments: [lit(st.expression.left.name), id(st.expression.left.name)],
          optional: false,
        },
      }, { _sh2Sync: true }));
      continue;
    }
    out2.push(st);
  }
  program.body = out2;
  return program;
}


// Does an expression (recursively) contain an AwaitExpression? Used to
// spot runtime-valued command substitutions (`x=$(cmd)`) that the emitter
// lifted to a NATIVE binding — their values vanish after the line runs
// (the A1 harvest only catches literals), so they need a store sync.
function exprHasAwait(node) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(exprHasAwait);
  if (node.type === "AwaitExpression") return true;
  return Object.keys(node).some((k) => k !== "loc" && exprHasAwait(node[k]));
}

// The hand-rolled emitter stays for direct sync use (tests, tiny trees)
// and as a documented fallback — astring is the production path.
export function estreeToJsSync(program) {
  return stripProcessEnv(program).body.map(statement).join("\n");
}

function statement(n) {
  switch (n.type) {
    case "ExpressionStatement":
      return expression(n.expression) + ";";
    case "BlockStatement":
      return block(n);
    case "IfStatement":
      return `if (${expression(n.test)}) ${statement(n.consequent)}` +
        (n.alternate ? ` else ${statement(n.alternate)}` : "");
    case "SwitchStatement":
      return `switch (${expression(n.discriminant)}) {\n` +
        n.cases.map(switchCase).join("") + "}";
    case "BreakStatement":
      return "break;";
    case "ReturnStatement":
      return `return ${n.argument ? expression(n.argument) : ""};`;
    case "VariableDeclaration":
      return `${n.kind || "let"} ${n.declarations
        .map((d) => `${d.id.name}${d.init ? " = " + expression(d.init) : ""}`)
        .join(", ")};`;
    case "FunctionDeclaration":
      return `function ${n.id.name}(${(n.params || []).map((p) => p.name).join(", ")}) ${block(n.body)}`;
    case "WhileStatement":
      return `while (${expression(n.test)}) ${statement(n.body)}`;
    case "ForStatement": {
      // classic three-clause for (the go/py/pl/c frontends emit this
      // shape; the sh/zsh/fish frontends use ForOfStatement instead).
      const init = n.init
        ? statement(n.init).replace(/;\s*$/, "")
        : "";
      return `for (${init}; ${n.test ? expression(n.test) : ""}; ${n.update ? expression(n.update) : ""}) ${statement(n.body)}`;
    }
    case "ForOfStatement": {
      // the otranspilerl estree backend's `for i in …` loop — the left is
      // a VariableDeclaration; render it without the statement's `;`.
      const left = n.left && n.left.type === "VariableDeclaration"
        ? `${n.left.kind || "let"} ${n.left.declarations.map((d) => d.id.name).join(", ")}`
        : statement(n.left);
      return `for (${left} of ${expression(n.right)}) ${statement(n.body)}`;
    }
    case "EmptyStatement":
      return "";
    default:
      throw new Error(`estree: unsupported statement ${n.type}`);
  }
}

function block(n) {
  const body = (n.body || []).map(statement).join("\n");
  return `{\n${body}\n}`;
}

function switchCase(n) {
  const label = n.test ? `case ${expression(n.test)}:` : "default:";
  const body = n.consequent.map(statement).join("\n");
  return `  ${label}\n${body}\n`;
}

function expression(n) {
  switch (n.type) {
    case "Identifier":
      return n.name;
    case "Literal":
      // The otranspilerl estree backend emits regex literals as
      // { value: {}, regex: { pattern, flags } }.
      if (n.regex) return `/${n.regex.pattern}/${n.regex.flags || ""}`;
      return JSON.stringify(n.value);  // arrays as literal values stringify fine
    case "SequenceExpression":
      return "(" + n.expressions.map(expression).join(", ") + ")";
    case "ConditionalExpression":
      return `${expression(n.test)} ? ${expression(n.consequent)} : ${expression(n.alternate)}`;
    case "TemplateLiteral":
      return template(n);
    case "MemberExpression":
      return expression(n.object) + (n.computed
        ? `[${expression(n.property)}]`
        : `.${expression(n.property)}`);
    case "CallExpression":
      return expression(n.callee) + "(" + n.arguments.map(expression).join(", ") + ")";
    case "AwaitExpression":
      return `await ${expression(n.argument)}`;
    case "LogicalExpression":
      // Always parenthesized — sidesteps &&/|| precedence entirely.
      return `(${expression(n.left)} ${n.operator} ${expression(n.right)})`;
    case "BinaryExpression":
      // Arithmetic/comparison (this debashcl build folds $((...)) and
      // [ x -le y ] into real JS binary expressions over let variables).
      return `(${expression(n.left)} ${n.operator} ${expression(n.right)})`;
    case "AssignmentExpression":
      return `(${expression(n.left)} ${n.operator} ${expression(n.right)})`;
    case "UnaryExpression":
      return n.operator + expression(n.argument);
    case "ArrayExpression":
      return "[" + (n.elements || []).map(expression).join(", ") + "]";
    case "ObjectExpression":
      return "{" + n.properties.map(prop).join(", ") + "}";
    case "ArrowFunctionExpression":
      return arrow(n);
    default:
      throw new Error(`estree: unsupported expression ${n.type}`);
  }
}

function prop(n) {
  const key = n.key.type === "Identifier" ? n.key.name : JSON.stringify(n.key.value);
  return `${key}: ${expression(n.value)}`;
}

function arrow(n) {
  const params = (n.params || []).map((p) => p.name).join(", ");
  if (n.expression) {
    const body = expression(n.body);
    // AwaitExpression at the top of an expression arrow body would be a
    // syntax error without parens when it starts with an object literal —
    // not the case here, but keep it simple and safe:
    return `${n.async ? "async " : ""}(${params}) => ${body}`;
  }
  return `${n.async ? "async " : ""}(${params}) => ${block(n.body)}`;
}

function template(n) {
  const quasis = n.quasis;
  const exprs = n.expressions || [];
  let out = "`";
  for (let i = 0; i < quasis.length; i++) {
    const cooked = quasis[i].value.cooked != null ? quasis[i].value.cooked : quasis[i].value.raw;
    // Escape so the emitted template literal means what the shell meant.
    out += String(cooked)
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${");
    if (i < exprs.length) out += "${" + expression(exprs[i]) + "}";
  }
  return out + "`";
}
