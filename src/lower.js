// ─── lower: rewrite provably-static shell arrays to native JS ────
//
// The estree backend lowers EVERYTHING through the dynamic sh2.*
// runtime store (`sh2.setArray("arr", …)`, `sh2.getVar("arr[1]")`,
// `sh2.param("slice","#arr","@","")`…). That is the conservative,
// always-correct path — shell variables are strings, arrays can be
// created/mutated by name at runtime, and every expansion has quirky
// semantics (unset element → "", `$arr` → element 0, sparse writes
// change `#arr[@]`'s count).
//
// But when the estree PROVES an array is simple — initialized exactly
// once, then only read (element access with a literal or computed
// index, `${#arr[@]}` length, `"${arr[@]}"` join) — the runtime calls
// are dead weight: a native `let arr = […]` with `arr[i]` / `arr.length`
// / `arr.join(" ")` is identical and much faster. This pass performs
// exactly that lowering, and ONLY in the provable subset:
//
//   • one `sh2.setArray("name", items)` call, at top level
//   • every other reference to `name` is one of:
//       sh2.getVar("name[INDEX]")      → (name[INDEX] !== undefined ? name[INDEX] : "")
//       sh2.param("slice","#name","@","") → name.length
//       sh2.param("slice","name","@","")  → name.join(" ")
//   • NO whole-var read (`$arr` → getVar("name")), NO `[*]` forms,
//     NO element/whole writes (they make `#arr[@]` count ≠ .length),
//     NO references inside a function body (scope safety)
//
// Everything else stays on the sh2.* runtime untouched. The pass is
// safe by construction: it never changes what the runtime calls would
// have done for the guarded shapes.
// -----------------------------------------------------------------

const isSh2 = (n, fn) =>
  n &&
  n.type === "CallExpression" &&
  n.callee &&
  n.callee.type === "MemberExpression" &&
  n.callee.object &&
  n.callee.object.type === "Identifier" &&
  n.callee.object.name === "sh2" &&
  (!fn || n.callee.property.name === fn);

// The string/template first arg of getVar/setVar ("arr[1]" /
// `arr[${i}]`) → { name, indexExpr | null } (null = whole-var read).
function parseVarArg(arg) {
  if (arg.type === "Literal") {
    const s = String(arg.value);
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\]]*)\]$/.exec(s);
    if (m) {
      // `[*]`/`[@]` are whole-array forms (word-split/join), NOT element
      // reads — treat them as whole-var reads so the guard excludes them.
      const idx = m[2];
      if (idx === "*" || idx === "@") return { name: m[1], index: null };
      return { name: m[1], index: idx };
    }
    return { name: s, index: null };
  }
  if (arg.type === "TemplateLiteral" && arg.expressions.length === 1) {
    const head = (arg.quasis[0] && arg.quasis[0].value.cooked) || "";
    const tail = (arg.quasis[1] && arg.quasis[1].value.cooked) || "";
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\[$/.exec(head);
    if (m && tail === "]") return { name: m[1], indexExpr: arg.expressions[0] };
  }
  return null;
}

function walk(n, fn) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) {
    for (const x of n) walk(x, fn);
    return;
  }
  fn(n);
  for (const k of Object.keys(n)) {
    if (k === "parent" || k === "loc") continue;
    const v = n[k];
    if (v && typeof v === "object") walk(v, fn);
  }
}

// Is `n` inside a FunctionDeclaration (a fresh scope — a name there may
// shadow the top-level one)?
function insideFunction(n, root) {
  let found = false;
  (function scan(x, inFn) {
    if (found || !x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach((y) => scan(y, inFn)); return; }
    if (x === n) { found = inFn; return; }
    const next = inFn || x.type === "FunctionDeclaration";
    for (const k of Object.keys(x)) {
      if (k === "loc") continue;
      const v = x[k];
      if (v && typeof v === "object") scan(v, next);
    }
  })(root, false);
  return found;
}

export function lowerNativeArrays(program) {
  if (!program || program.type !== "Program") return program;
  const body = program.body || [];

  // 1. collect per-name sh2 references.
  const refs = new Map(); // name → [{ node, kind }]
  const setArrays = [];   // { node, name, items }
  for (const stmt of body) {
    const nameRefs = [];
    walk(stmt, (n) => {
      if (!isSh2(n)) return;
      const fn = n.callee.property.name;
      if (fn === "setArray") {
        const nameArg = n.arguments[0];
        const items = n.arguments[1];
        if (nameArg && nameArg.type === "Literal" && items && items.type === "ArrayExpression") {
          setArrays.push({ node: n, name: String(nameArg.value), items });
          nameRefs.push({ node: n, kind: "setArray", name: String(nameArg.value) });
        }
        return;
      }
      if (fn === "getVar" || fn === "setVar") {
        const arg = n.arguments[0];
        const parsed = arg && parseVarArg(arg);
        if (parsed) {
          nameRefs.push({ node: n, kind: fn, name: parsed.name, index: parsed.index, indexExpr: parsed.indexExpr });
          return;
        }
        return;
      }
      if (fn === "arrayLen") {
        // `${#arr[@]}` lowers to sh2.arrayLen("arr") in the current
        // estree backend (the older sh2.param("slice", "#arr", "@", "")
        // shape is handled below) — SAME len read: without this, the
        // length call survives the lowering while the array itself went
        // native (never in the runtime Map) and reads 0.
        const arg = n.arguments[0];
        if (arg && arg.type === "Literal") {
          nameRefs.push({ node: n, kind: "len", name: String(arg.value) });
          return;
        }
        return;
      }
      if (fn === "param") {
        const op = n.arguments[0];
        const target = n.arguments[1];
        const mode = n.arguments[2];
        if (
          op && op.type === "Literal" && op.value === "slice" &&
          target && target.type === "Literal" &&
          mode && mode.type === "Literal" && mode.value === "@"
        ) {
          const t = String(target.value);
          if (t.startsWith("#")) {
            nameRefs.push({ node: n, kind: "len", name: t.slice(1) });
            return;
          }
          nameRefs.push({ node: n, kind: "join", name: t });
          return;
        }
        return;
      }
      if (fn === "unset") {
        const arg = n.arguments[0];
        if (arg && arg.type === "Literal") {
          nameRefs.push({ node: n, kind: "unset", name: String(arg.value) });
        }
      }
    });
    for (const r of nameRefs) {
      if (!refs.has(r.name)) refs.set(r.name, []);
      refs.get(r.name).push(r);
    }
  }

  // 2. decide: exactly one top-level setArray; all other refs are
  //    getVar-with-index / len / join; nothing in a function body.
  const natives = new Map(); // name → items node
  for (const sa of setArrays) {
    const name = sa.name;
    const list = refs.get(name) || [];
    const setArrayCount = list.filter((r) => r.kind === "setArray").length;
    if (setArrayCount !== 1) continue;
    // every other ref must be getVar-with-index / len / join (read-only)
    const ok = list.every((r) => {
      if (r.kind === "setArray") return true;
      if (r.kind === "getVar") return r.index !== null || r.indexExpr !== undefined;
      return r.kind === "len" || r.kind === "join";
    });
    if (!ok) continue;
    // no refs inside a function body (scope safety)
    if (list.some((r) => insideFunction(r.node, program))) continue;
    // no pre-existing declaration of the name
    let declared = false;
    walk(program, (n) => {
      if (declared) return;
      if (n.type === "VariableDeclarator" && n.id && n.id.name === name) declared = true;
    });
    if (declared) continue;
    natives.set(name, sa.items);
  }
  if (natives.size === 0) return program;

  // 3. apply.
  //    a) setArray statement → `let name = items;`
  const newBody = [];
  for (const stmt of body) {
    let replaced = false;
    if (stmt.type === "ExpressionStatement" && stmt.expression && isSh2(stmt.expression, "setArray")) {
      const nameArg = stmt.expression.arguments[0];
      if (nameArg && nameArg.type === "Literal" && natives.has(String(nameArg.value))) {
        newBody.push({
          type: "VariableDeclaration",
          kind: "let",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: String(nameArg.value) },
              init: stmt.expression.arguments[1],
            },
          ],
        });
        replaced = true;
      }
    }
    if (!replaced) newBody.push(stmt);
  }
  program.body = newBody;

  //    b) rewrite the read calls in place.
  for (const name of natives.keys()) {
    for (const r of refs.get(name) || []) {
      if (r.kind === "setArray") continue;
      const n = r.node;
      if (r.kind === "getVar") {
        const index = r.indexExpr !== undefined
          ? r.indexExpr
          : { type: "Literal", value: Number(r.index), raw: null };
        const elem = {
          type: "MemberExpression",
          object: { type: "Identifier", name },
          property: index,
          computed: true,
          optional: false,
        };
        // (name[i] !== undefined ? name[i] : "")
        n.type = "ConditionalExpression";
        delete n.callee;
        delete n.arguments;
        n.test = {
          type: "BinaryExpression",
          operator: "!==",
          left: elem,
          right: { type: "Identifier", name: "undefined" },
        };
        n.consequent = elem;
        n.alternate = { type: "Literal", value: "", raw: null };
      } else if (r.kind === "len") {
        n.type = "MemberExpression";
        delete n.callee;
        delete n.arguments;
        n.object = { type: "Identifier", name };
        n.property = { type: "Identifier", name: "length" };
        n.computed = false;
        n.optional = false;
      } else if (r.kind === "join") {
        n.type = "CallExpression";
        delete n.callee;
        delete n.arguments;
        n.callee = {
          type: "MemberExpression",
          object: { type: "Identifier", name },
          property: { type: "Identifier", name: "join" },
          computed: false,
          optional: false,
        };
        n.arguments = [{ type: "Literal", value: " ", raw: null }];
      }
    }
  }
  return program;
}

// ── hoistLoopLastExit: pull constant `sh2.lastExit = N` out of loops ──
//
// Every command statement renders as `(cmd?, sh2.lastExit = N, flag)` —
// the exit-code record + the success flag. Inside a loop whose body sets
// the SAME constant N every time, that per-iteration assignment is
// redundant: `$?` reads anywhere in the loop see N anyway, and after the
// loop it is still N. Hoist a single `sh2.lastExit = N;` before the loop
// and drop the per-statement assigns (the success flag stays).
//
// Guard (conservative): every sequence-flag statement must assign the
// same numeric literal, no non-flag statement may touch sh2.lastExit,
// and the body must contain no `sh2.lastExit` READ (a `$?` inside the
// loop is fine only if the hoisted value still matches every read point
// — which it does when the body sets one constant, but a read between
// two different-valued commands would break it, so reads anywhere in the
// body veto the transform).

const isLoopNode = (n) =>
  n &&
  (n.type === "ForOfStatement" ||
    n.type === "ForStatement" ||
    n.type === "WhileStatement" ||
    n.type === "DoWhileStatement");

const isLastExitMember = (n) =>
  n &&
  n.type === "MemberExpression" &&
  n.object &&
  n.object.type === "Identifier" &&
  n.object.name === "sh2" &&
  n.property &&
  n.property.type === "Identifier" &&
  n.property.name === "lastExit";

// `sh2.lastExit = <number literal>` assignment node?
function lastExitAssign(e) {
  if (
    e &&
    e.type === "AssignmentExpression" &&
    e.operator === "=" &&
    isLastExitMember(e.left) &&
    e.right &&
    e.right.type === "Literal" &&
    typeof e.right.value === "number"
  ) {
    return e.right.value;
  }
  return null;
}

// A command statement: ExpressionStatement wrapping a SequenceExpression
// ending in `[sh2.lastExit = N, flag]`. Returns N or null.
function seqFlagValue(stmt) {
  if (
    !stmt ||
    stmt.type !== "ExpressionStatement" ||
    !stmt.expression ||
    stmt.expression.type !== "SequenceExpression"
  ) {
    return null;
  }
  const parts = stmt.expression.expressions;
  if (parts.length < 2) return null;
  const n = lastExitAssign(parts[parts.length - 2]);
  return n === null ? null : n; // the last element is the success flag
}

// Walk n; fn(node, parent, keyOrIndex). `parent` is the object whose
// `key` holds `node` (or an array element).
function walkWithParent(n, parent, key, fn) {
  if (!n || typeof n !== "object") return;
  fn(n, parent, key);
  if (Array.isArray(n)) {
    n.forEach((x, i) => walkWithParent(x, n, i, fn));
    return;
  }
  for (const k of Object.keys(n)) {
    if (k === "loc" || k === "parent") continue;
    const v = n[k];
    if (v && typeof v === "object") walkWithParent(v, n, k, fn);
  }
}

export function hoistLoopLastExit(program) {
  const hoists = [];
  walkWithParent(program, null, null, (loop, parent, key) => {
    if (!isLoopNode(loop) || !Array.isArray(parent) || typeof key !== "number") return;
    const body = loop.body && loop.body.type === "BlockStatement" ? loop.body.body : null;
    if (!body || body.length === 0) return;
    let value = null;
    let ok = true;
    const flagStmts = [];
    for (const stmt of body) {
      const v = seqFlagValue(stmt);
      if (v !== null) {
        if (value === null) value = v;
        else if (value !== v) { ok = false; break; }
        flagStmts.push(stmt);
        continue;
      }
      // a non-flag statement must not touch sh2.lastExit at all
      let touches = false;
      walkWithParent(stmt, null, null, (n) => {
        if (isLastExitMember(n)) touches = true;
      });
      if (touches) { ok = false; break; }
    }
    if (!ok || value === null || flagStmts.length === 0) return;
    // no sh2.lastExit READ anywhere in the body (the trailing assigns'
    // lefts are the only allowed mentions)
    const assignLefts = new Set();
    for (const st of flagStmts) {
      const parts = st.expression.expressions;
      assignLefts.add(parts[parts.length - 2].left);
    }
    let read = false;
    walkWithParent(loop, null, null, (n) => {
      if (read) return;
      if (isLastExitMember(n) && !assignLefts.has(n)) read = true;
    });
    if (read) return;
    hoists.push({ loop, parent, key, flagStmts, value });
  });

  for (const h of hoists) {
    // drop the per-statement assigns, keep (cmd, flag)
    for (const st of h.flagStmts) {
      st.expression.expressions = st.expression.expressions.filter(
        (e) => lastExitAssign(e) === null,
      );
    }
    // `sh2.lastExit = value;` before the loop
    const hoisted = {
      type: "ExpressionStatement",
      expression: {
        type: "AssignmentExpression",
        operator: "=",
        left: {
          type: "MemberExpression",
          object: { type: "Identifier", name: "sh2" },
          property: { type: "Identifier", name: "lastExit" },
          computed: false,
          optional: false,
        },
        right: { type: "Literal", value: h.value, raw: null },
      },
    };
    h.parent.splice(h.parent.indexOf(h.loop), 0, hoisted);
  }
  return program;
}

// ── dropDeadFlags: remove unconsumed success flags from statements ──
//
// A command statement's VALUE is its success flag: `(cmd?, flag)` — the
// last element is what `if`/`while`/`&&`/`||` and the program's
// last-statement exit-code convention read. But a standalone
// ExpressionStatement's value is consumed ONLY when it is the program's
// last statement (jtsh's runViaTranspiler turns that value into the
// exit code). Every other ExpressionStatement — loop bodies, blocks,
// branches — has a dead value, so `(cmd, true)` is just `cmd`.
//
// Also unwraps 1-element sequences left by hoistLoopLastExit (a bare
// `(false)` after the lastExit assign was hoisted out) and drops
// literal-only statements (no side effects).

export function dropDeadFlags(program) {
  if (!program || program.type !== "Program") return program;
  const body = program.body || [];
  const last = body[body.length - 1];

  // True only for expressions with NO observable effect (no calls, no
  // assignments, no member reads that could be getters). The trailing
  // element of `(cmd, flag)` is only a dead flag when it is pure — an
  // if-statement lowers to `(test, lastExit === 0 ? BRANCH : false)`
  // where the tail is the BRANCH conditional (stdout.write, lastExit
  // assigns…), which popping would DELETE. Never pop a side-effecting
  // tail.
  const pureExpr = (e) => {
    if (!e) return false;
    switch (e.type) {
      case "Literal": return true;
      case "Identifier": return true;
      case "TemplateLiteral": return e.expressions.every(pureExpr);
      case "UnaryExpression": return pureExpr(e.argument);
      case "BinaryExpression":
      case "LogicalExpression": return pureExpr(e.left) && pureExpr(e.right);
      case "ConditionalExpression":
        return pureExpr(e.test) && pureExpr(e.consequent) && pureExpr(e.alternate);
      default: return false;
    }
  };

  const processStmt = (stmt) => {
    if (
      !stmt ||
      stmt.type !== "ExpressionStatement" ||
      !stmt.expression ||
      stmt.expression.type !== "SequenceExpression"
    ) {
      return;
    }
    const seq = stmt.expression;
    if (stmt === last) return; // the last statement's value IS the exit flag
    if (seq.expressions.length === 1) {
      // `(flag)` — a bare success flag left after lastExit hoisting.
      // Unwrap if it has side effects; literal-only → dead, drop below.
      if (seq.expressions[0].type !== "Literal") stmt.expression = seq.expressions[0];
      else stmt._dead = true;
      return;
    }
    // the trailing success flag — unconsumed here — but ONLY when it is
    // pure (see the header comment: branch conditionals aren't flags)
    if (!pureExpr(seq.expressions[seq.expressions.length - 1])) return;
    seq.expressions.pop();
    if (seq.expressions.length === 1) stmt.expression = seq.expressions[0];
  };

  walk(program, (n) => {
    if (n.type === "ExpressionStatement") processStmt(n);
  });
  // drop literal-only dead statements at every level
  (function prune(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (let i = n.length - 1; i >= 0; i--) {
        const x = n[i];
        if (x && x.type === "ExpressionStatement" && x._dead) {
          n.splice(i, 1);
          continue;
        }
        prune(x);
      }
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "parent") continue;
      const v = n[k];
      if (v && typeof v === "object") prune(v);
    }
  })(program);
  return program;
}

// ── mergeInitAssignments: fold `let v = 0; v = EXPR;` into `let v = EXPR` ──
//
// The estree emitter hoists every variable as `let v = DEFAULT` (the
// TDZ/conditional-assignment safety net) and emits the real assignment
// as a separate statement. When that assignment is UNCONDITIONAL and is
// the FIRST statement touching `v`, the two collapse into one
// declaration — `let v = 0; v = 6;` → `let v = 6;` is exactly
// equivalent (nothing observed the default in between). Adjacent `let`
// declarations also merge into one `let a = .., b = ..;`.
//
// Guard (per variable): no read of `v` and no other assignment/use
// before the candidate assignment, the assignment is a top-level `=`
// (not `+=` etc., not inside a block/loop/function), and the RHS does
// not reference `v` (a self-reference would hit the TDZ in the folded
// initializer). CRITICAL: the fold moves the RHS evaluation to the
// declaration site, so the RHS must be PURE — a side-effecting call
// (`sh2.date(…)`, `String(…).replace(…)`) or sequence would run
// EARLIER (before the interleaved statements) and change observable
// order (errors, sh2.lastExit, reads of later-mutated vars). Runs per
// statement-list (program / blocks / functions).

export function mergeInitAssignments(program) {
  // True for expressions that can be evaluated with no observable
  // effect and cannot throw: literals, pure arithmetic/string ops on
  // pure parts, and plain variable reads.
  const isPureExpr = (e) => {
    if (!e) return false;
    switch (e.type) {
      case "Literal": return true;
      case "Identifier": return true;
      case "TemplateLiteral": return e.expressions.every(isPureExpr);
      case "UnaryExpression": return isPureExpr(e.argument);
      case "BinaryExpression":
      case "LogicalExpression": return isPureExpr(e.left) && isPureExpr(e.right);
      case "ConditionalExpression": return isPureExpr(e.test) && isPureExpr(e.consequent) && isPureExpr(e.alternate);
      case "ArrayExpression": return e.elements.every((x) => !x || isPureExpr(x));
      default: return false;   // calls, member reads (getters), sequences, assignments, …
    }
  };
  const readsVars = (e, out) => {
    walk(e, (n) => { if (n.type === "Identifier") out.add(n.name); });
  };
  const stmtWrites = (s, out) => {
    walk(s, (n) => {
      if (n.type === "AssignmentExpression" && n.left && n.left.type === "Identifier") out.add(n.left.name);
      if (n.type === "UpdateExpression" && n.argument && n.argument.type === "Identifier") out.add(n.argument.name);
      if (n.type === "VariableDeclarator" && n.id && n.id.type === "Identifier") out.add(n.id.name);
    });
  };
  const mergeList = (stmts) => {
    if (!Array.isArray(stmts)) return;
    // name → { declIdx, declarator, declStmt }
    const decls = new Map();
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i];
      if (stmt && stmt.type === "VariableDeclaration" && stmt.kind === "let") {
        for (const d of stmt.declarations) {
          if (d.id && d.id.type === "Identifier" && d.init && d.init.type === "Literal") {
            decls.set(d.id.name, { i, stmt, d });
          }
        }
      }
    }
    // for each declared name, scan forward to the first statement that
    // touches it
    const drop = new Set(); // statement indices to remove (the folded assigns)
    for (const [name, info] of decls) {
      let firstTouch = null; // { idx, stmt, isAssign }
      let bad = false;
      for (let j = info.i + 1; j < stmts.length; j++) {
        const stmt = stmts[j];
        // does this statement touch `name`?
        const touch = { reads: false, assigns: false };
        walk(stmt, (n) => {
          if (n.type === "Identifier" && n.name === name) {
            // an Identifier as the left of an `=` assignment is a write
            if (
              n === (stmt.expression && stmt.expression.left) &&
              stmt.type === "ExpressionStatement" &&
              stmt.expression.type === "AssignmentExpression"
            ) {
              touch.assigns = true;
            } else {
              touch.reads = true;
            }
          }
        });
        if (touch.reads || touch.assigns) { firstTouch = { j, stmt, touch }; break; }
      }
      if (!firstTouch || firstTouch.touch.reads) continue; // read first or never touched
      const stmt = firstTouch.stmt;
      const expr = stmt.expression;
      if (
        stmt.type !== "ExpressionStatement" ||
        !expr ||
        expr.type !== "AssignmentExpression" ||
        expr.operator !== "=" ||
        !expr.left ||
        expr.left.type !== "Identifier" ||
        expr.left.name !== name
      ) {
        continue; // first touch is not a plain `name = ...`
      }
      // RHS must not reference `name` (TDZ in the folded initializer)
      // and must be side-effect-free (the fold moves its evaluation to
      // the declaration site — see the header comment).
      let selfRef = false;
      walk(expr.right, (n) => {
        if (n.type === "Identifier" && n.name === name) selfRef = true;
      });
      if (selfRef) continue;
      if (!isPureExpr(expr.right)) continue;
      // identifier reads in the RHS must not be written by any statement
      // between the declaration and the assignment (the read would move
      // earlier, seeing the pre-write value)
      const reads = new Set();
      readsVars(expr.right, reads);
      if (reads.size) {
        let clobbered = false;
        for (let k = info.i + 1; k < firstTouch.j && !clobbered; k++) {
          const w = new Set();
          stmtWrites(stmts[k], w);
          for (const r of reads) if (w.has(r)) { clobbered = true; break; }
        }
        if (clobbered) continue;
      }
      info.d.init = expr.right;
      drop.add(firstTouch.j);
    }
    if (drop.size) {
      for (let i = stmts.length - 1; i >= 0; i--) {
        if (drop.has(i)) stmts.splice(i, 1);
      }
    }
    // merge adjacent `let` declarations into one (`let a = 1, b = 2;`)
    for (let i = stmts.length - 1; i > 0; i--) {
      const a = stmts[i - 1], b = stmts[i];
      if (
        a && b && a.type === "VariableDeclaration" && b.type === "VariableDeclaration" &&
        a.kind === "let" && b.kind === "let"
      ) {
        a.declarations.push(...b.declarations);
        stmts.splice(i, 1);
      }
    }
  };

  mergeList(program.body);
  walk(program, (n) => {
    if (n.type === "BlockStatement") mergeList(n.body);
    if (n.type === "FunctionDeclaration" && n.body) mergeList(n.body.body);
  });
  return program;
}

// ── hoistCommonLastExit: pull a constant `sh2.lastExit = N` out of
//    if/else (and else-if chains) ──
//
// Both branches of an if set the SAME exit code (`(cmd, lastExit = 0,
// flag)` in each) — the value of `$?` is N whichever branch runs, so a
// single `sh2.lastExit = N;` before the if is equivalent to the
// per-branch assigns. Same invariant as hoistLoopLastExit.
//
// Guard: every command statement in every branch must assign the same
// numeric literal; non-flag statements must not touch sh2.lastExit; no
// `sh2.lastExit` READ anywhere inside the if (beyond the trailing
// assigns); and the if must sit in a statement list (so we can insert
// before it).

export function hoistCommonLastExit(program) {
  const hoists = [];
  walkWithParent(program, null, null, (ifNode, parent, key) => {
    if (!ifNode || ifNode.type !== "IfStatement") return;
    if (!Array.isArray(parent) || typeof key !== "number") return;
    let value = null;
    let ok = true;
    const flagStmts = [];
    const visit = (branch) => {
      if (!ok || !branch) return;
      if (branch.type === "BlockStatement") {
        for (const stmt of branch.body) {
          const v = seqFlagValue(stmt);
          if (v !== null) {
            if (value === null) value = v;
            else if (value !== v) { ok = false; return; }
            flagStmts.push(stmt);
          } else if (stmt.type === "IfStatement") {
            visit(stmt.consequent); // else-if chain
            visit(stmt.alternate);
          } else if (touchesLastExit(stmt)) {
            ok = false;
          }
        }
      } else if (branch.type === "IfStatement") {
        visit(branch.consequent);
        visit(branch.alternate);
      } else {
        const v = seqFlagValue(branch);
        if (v !== null) {
          if (value === null) value = v;
          else if (value !== v) { ok = false; return; }
          flagStmts.push(branch);
        } else if (touchesLastExit(branch)) {
          ok = false;
        }
      }
    };
    visit(ifNode.consequent);
    visit(ifNode.alternate);
    if (!ok || value === null || flagStmts.length === 0) return;
    // no lastExit READ anywhere in the if. A lastExit member is a WRITE
    // when it is the left of an `=` assignment (the trailing assigns, or
    // a same-constant write like a `true` builtin rendered as a test:
    // `if ((sh2.lastExit = 0, true))`); anything else is a read ($?)
    // → veto.
    const assignLefts = new Set();
    for (const st of flagStmts) {
      const parts = st.expression.expressions;
      assignLefts.add(parts[parts.length - 2].left);
    }
    const writes = new Map(); // left node → right node
    walkWithParent(ifNode, null, null, (n) => {
      if (n.type === "AssignmentExpression" && n.operator === "=" && isLastExitMember(n.left)) {
        writes.set(n.left, n.right);
      }
    });
    let bad = false;
    walkWithParent(ifNode, null, null, (n) => {
      if (bad) return;
      if (!isLastExitMember(n)) return;
      if (writes.has(n)) {
        // a write: fine if it is one of the trailing assigns (value N by
        // construction) or sets the same literal value
        const right = writes.get(n);
        const sameVal = right && right.type === "Literal" && right.value === value;
        if (!assignLefts.has(n) && !sameVal) bad = true;
      } else {
        bad = true; // a genuine `$?` read
      }
    });
    if (bad) return;
    hoists.push({ ifNode, parent, key, flagStmts, value });
  });

  for (const h of hoists) {
    for (const st of h.flagStmts) {
      st.expression.expressions = st.expression.expressions.filter(
        (e) => lastExitAssign(e) === null,
      );
    }
    const hoisted = {
      type: "ExpressionStatement",
      expression: {
        type: "AssignmentExpression",
        operator: "=",
        left: {
          type: "MemberExpression",
          object: { type: "Identifier", name: "sh2" },
          property: { type: "Identifier", name: "lastExit" },
          computed: false,
          optional: false,
        },
        right: { type: "Literal", value: h.value, raw: null },
      },
    };
    h.parent.splice(h.parent.indexOf(h.ifNode), 0, hoisted);
  }
  return program;
}

// Does a statement contain ANY sh2.lastExit reference (read or write)?
function touchesLastExit(stmt) {
  let found = false;
  walkWithParent(stmt, null, null, (n) => {
    if (isLastExitMember(n)) found = true;
  });
  return found;
}

// ── pushLastExitToEnd: move hoisted `sh2.lastExit = N;` to the end of
//    its statement list when nothing between touches it ──
//
// hoistLoopLastExit / hoistCommonLastExit place the exit-code record
// BEFORE the construct. When every statement after it is lastExit-free
// (the construct's own paths already set N everywhere, and nothing
// reads `$?` in the tail), the assignment can sit at the END instead —
// the value is N at every intervening point either way. Adjacent
// same-value assignments (nested hoists) then merge into one.

export function pushLastExitToEnd(program) {
  const isLe = (s) =>
    s &&
    s.type === "ExpressionStatement" &&
    s.expression &&
    s.expression.type === "AssignmentExpression" &&
    s.expression.operator === "=" &&
    isLastExitMember(s.expression.left);
  const neutral = (s) => {
    let t = false;
    walkWithParent(s, null, null, (n) => {
      if (isLastExitMember(n)) t = true;
    });
    return !t;
  };
  const processList = (stmts) => {
    if (!Array.isArray(stmts) || stmts.length < 2) return;
    let moved = true;
    while (moved) {
      moved = false;
      for (let i = stmts.length - 2; i >= 0; i--) {
        const s = stmts[i];
        if (!isLe(s)) continue;
        // the latest safe position: the very end when the whole tail is
        // lastExit-free, else just before the FIRST statement that
        // touches lastExit (the value N is constant, so every neutral
        // statement in between observes the same N either way)
        let firstTouch = -1;
        for (let j = i + 1; j < stmts.length; j++) {
          if (!neutral(stmts[j])) { firstTouch = j; break; }
        }
        if (firstTouch === -1) {
          stmts.splice(i, 1);
          stmts.push(s);
          moved = true;
          break;
        } else if (firstTouch > i + 1) {
          stmts.splice(i, 1);
          stmts.splice(firstTouch - 1, 0, s);
          moved = true;
          break;
        }
      }
    }
    // merge adjacent same-value lastExit assignments
    for (let i = stmts.length - 1; i > 0; i--) {
      const a = stmts[i - 1], b = stmts[i];
      if (isLe(a) && isLe(b) && a.expression.right.value === b.expression.right.value) {
        stmts.splice(i, 1);
      }
    }
  };
  processList(program.body);
  walk(program, (n) => {
    if (n.type === "BlockStatement") processList(n.body);
    if (n.type === "FunctionDeclaration" && n.body) processList(n.body.body);
  });
  return program;
}
