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

// ── flattenAndOrAll: lower `await sh2.and/or(…)` in EVERY position ──
//
// whileLoopParts flattens the runtime and/or chains only in loop
// conditions. The same shapes also gate function purity in
// if-conditions (`if (await sh2.and(async () => a, async () => b))` —
// mime_at's equality tests), and an async-free function is then lowered
// by the fixpoint (its exec calls to lowered callees become direct).
// Rewrite every `await sh2.and(f1, …)` / `await sh2.or(f1, …)` whose
// leaves are all sync into a native `&&` / `||` chain (short-circuit and
// truthiness are identical; the `!!` coercion is a no-op in boolean
// positions). Chains with an awaiting leaf are left to the runtime.
export function flattenAndOrAll(program) {
  if (!program || program.type !== "Program") return program;
  const rewrite = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(rewrite);
    if (node.type === "AwaitExpression" && node.argument && node.argument.type === "CallExpression" &&
        node.argument.callee && node.argument.callee.type === "MemberExpression" &&
        node.argument.callee.object && node.argument.callee.object.type === "Identifier" &&
        node.argument.callee.object.name === "sh2" &&
        node.argument.callee.property && node.argument.callee.property.type === "Identifier" &&
        (node.argument.callee.property.name === "and" || node.argument.callee.property.name === "or")) {
      const flat = flattenAndOr(node);
      if (flat) return rewrite(flat);
    }
    const out = {};
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "parent") continue;
      out[k] = rewrite(node[k]);
    }
    return out;
  };
  program.body = program.body.map(rewrite);
  return program;
}

// ── plainIfTests: strip the dead `$?` framing from IF conditions ──
//
// The wasm's condition renderer threads every test as
//   if ((sh2._g = COND, sh2.lastExit = sh2._g ? 0 : 1, sh2._g))
// so the test's `$?` status exists for a later read. But an `if`
// statement consumes ONLY the condition VALUE (the trailing `sh2._g`);
// the `sh2.lastExit` SET inside is always overwritten by the next
// statement's condition before anything reads it (surveyed: 0 of 421
// framed ifs in mimecroft have a lastExit READ between the if and the
// next write — the else-branch `sh2.lastExit = 0` clears confirm the
// lifecycle). Emit `if (COND)` with the framing stripped: 3 store
// writes + the conditional vanish per test. The `&&`/`||` CHAINED
// tests (the `sh2.lastExit === 0` intermediate form) are left alone —
// those genuinely consume the status.
export function plainIfTests(program) {
  if (!program || program.type !== "Program") return program;
  const isSh2Member = (n, prop) =>
    n && n.type === "MemberExpression" && !n.computed &&
    n.object && n.object.type === "Identifier" && n.object.name === "sh2" &&
    n.property && n.property.type === "Identifier" && n.property.name === prop;
  const framed = (test) => {
    if (!test || test.type !== "SequenceExpression" || !Array.isArray(test.expressions) || test.expressions.length !== 3) return null;
    const [a, b, c] = test.expressions;
    if (!(a && a.type === "AssignmentExpression" && a.operator === "=" && isSh2Member(a.left, "_g"))) return null;
    if (!(b && b.type === "AssignmentExpression" && b.operator === "=" && isSh2Member(b.left, "lastExit"))) return null;
    // the trailing value is `sh2._g` (the generator renders the member)
    if (!(c && c.type === "MemberExpression" && isSh2Member(c, "_g"))) return null;
    return a.right;
  };
  const rewrite = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(rewrite);
    if (node.type === "IfStatement" && node.test) {
      const plain = framed(node.test);
      if (plain) node.test = plain;
    }
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "parent") continue;
      node[k] = rewrite(node[k]);
    }
    return node;
  };
  rewrite(program);
  return program;
}

// ── lowerDeviceRedirects: compile `echo X > /dev/…` into fs.write ──
//
// `await sh2.redirect(async () => await sh2.exec("echo", [ARG]), [{fd: 1,
// mode: "w", target: "/dev/webgl/..."}])` is a pure device write behind
// three shell layers (redirect mode plumbing → exec dispatch → shellExec
// → fs.write). With the /dev mount table being a stable runtime fact,
// the whole statement is exactly `await fs.write(target, ARG + "\n")`.
// The $? record (echo succeeds) is preserved with `sh2.lastExit = 0`.
//
// Guards: the inner command must be `echo` with ONE argument (echo joins
// multiple args with spaces — not compiled), the redirect must be a
// single {fd: 1, mode: "w", target: <literal path>} (append "a" reads
// the old content — not compiled), and `echo` must not be shadowed by a
// user function. Everything else stays on the runtime redirect.
export function lowerDeviceRedirects(program) {
  if (!program || program.type !== "Program") return program;
  // echo must not be a user function (bash precedence: a define shadows
  // the builtin — then the redirect is NOT a plain fs.write)
  let echoShadowed = false;
  walk(program, (n) => {
    if (!echoShadowed && n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
        n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
        n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === "define" &&
        n.arguments && n.arguments[0] && n.arguments[0].type === "Literal" && n.arguments[0].value === "echo") {
      echoShadowed = true;
    }
  });

  const fsWrite = (target, arg) => ({
    type: "CallExpression",
    callee: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "fs" }, property: { type: "Identifier", name: "write" } },
    arguments: [
      { type: "Literal", value: target, raw: null },
      { type: "BinaryExpression", operator: "+", left: arg, right: { type: "Literal", value: "\n", raw: null } },
    ],
    optional: false,
  });

  const rewriteStmt = (stmt) => {
    if (!stmt || stmt.type !== "ExpressionStatement" || !stmt.expression) return null;
    let e = stmt.expression;
    // top-level statements carry an `sh2.guard(…)` wrapper
    if (e.type === "CallExpression" && e.callee && e.callee.type === "MemberExpression" &&
        e.callee.object && e.callee.object.type === "Identifier" && e.callee.object.name === "sh2" &&
        e.callee.property && e.callee.property.type === "Identifier" && e.callee.property.name === "guard" &&
        e.arguments && e.arguments.length === 1) e = e.arguments[0];
    if (e.type !== "AwaitExpression") return null;
    const call = e.argument;
    if (!call || call.type !== "CallExpression" || call.callee && call.callee.type !== "MemberExpression" ||
        !call.callee || call.callee.object && call.callee.object.type !== "Identifier" ||
        !call.callee.object || call.callee.object.name !== "sh2" ||
        call.callee.property && call.callee.property.type !== "Identifier" ||
        !call.callee.property || call.callee.property.name !== "redirect" ||
        !call.arguments || call.arguments.length !== 2) return null;
    const arrow = call.arguments[0];
    if (!arrow || arrow.type !== "ArrowFunctionExpression") return null;
    let inner = arrow.expression ? arrow.body :
      (arrow.body && arrow.body.type === "BlockStatement" && arrow.body.body.length === 1 &&
       arrow.body.body[0].type === "ReturnStatement" ? arrow.body.body[0].argument : null);
    if (!inner || inner.type !== "AwaitExpression") return null;
    const exec = inner.argument;
    if (!exec || exec.type !== "CallExpression" || exec.callee && exec.callee.type !== "MemberExpression" ||
        !exec.callee || exec.callee.object && exec.callee.object.type !== "Identifier" ||
        !exec.callee.object || exec.callee.object.name !== "sh2" ||
        exec.callee.property && exec.callee.property.type !== "Identifier" ||
        !exec.callee.property || exec.callee.property.name !== "exec" ||
        !exec.arguments || exec.arguments.length !== 2 ||
        exec.arguments[0].type !== "Literal" || exec.arguments[0].value !== "echo" ||
        exec.arguments[1].type !== "ArrayExpression" || exec.arguments[1].elements.length !== 1) return null;
    const arg = exec.arguments[1].elements[0];
    if (!arg) return null;
    const redirs = call.arguments[1];
    if (!redirs || redirs.type !== "ArrayExpression" || redirs.elements.length !== 1) return null;
    const o = redirs.elements[0];
    if (!o || o.type !== "ObjectExpression" || !o.properties) return null;
    let fd = null, mode = null, target = null;
    for (const p of o.properties) {
      const k = p.key && (p.key.name || p.key.value);
      if (k === "fd" && p.value.type === "Literal") fd = p.value.value;
      if (k === "mode" && p.value.type === "Literal") mode = p.value.value;
      if (k === "target" && p.value.type === "Literal") target = p.value.value;
    }
    if (fd !== 1 || mode !== "w" || typeof target !== "string" || target.startsWith("&")) return null;
    // a template/string arg keeps its own interpolations — just append \n
    return {
      type: "ExpressionStatement",
      expression: {
        type: "SequenceExpression",
        expressions: [
          { type: "AwaitExpression", argument: fsWrite(target, arg) },
          {
            type: "AssignmentExpression", operator: "=",
            left: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: "lastExit" } },
            right: { type: "Literal", value: 0, raw: null },
          },
        ],
      },
    };
  };

  const rewrite = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(rewrite);
    if (node.type === "BlockStatement" && Array.isArray(node.body)) {
      node.body = node.body.map((s) => (echoShadowed ? s : rewriteStmt(s) || rewrite(s)));
      return node;
    }
    if (node.type === "Program" && Array.isArray(node.body)) {
      node.body = node.body.map((s) => (echoShadowed ? s : rewriteStmt(s) || rewrite(s)));
      return node;
    }
    const out = {};
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "parent") continue;
      out[k] = rewrite(node[k]);
    }
    return out;
  };
  return rewrite(program);
}

// ── lowerPureFunctions: pull await-free helpers out of the shell ──
//
// `sh2.define("f", async () => { … })` with an AWAIT-FREE body is a
// pure integer helper (lat_hash / smooth_w / clamp in the texture
// generators): every call pays the async exec dispatch (function-table
// lookup, scriptArgs save/restore, argument stringifying, a Promise)
// and every math step pays a store round-trip
// (`sh2.setVar("V", sh2.arithEval(() => Number(sh2.getVar("V")) || 0 …))`).
// The pass converts the helper to a NATIVE function:
//
//   • the leading `sh2.setVar("V", sh2.getVar("N"))` param copies become
//     real parameters
//   • every other store var the body touches becomes a native local
//     (initialised from the store — faithful to the unset "" default);
//     a var READ OUTSIDE the function is synced back at the end
//   • `sh2.setVar("V", sh2.arithEval(() => EXPR))` → `V = EXPR`,
//     `sh2.getVar("V")` → `V`, `"$V"` test operands → `${V}`
//     interpolations, `(Number(V) || 0)` guards on non-param locals → `V`
//   • call sites `await sh2.exec("f", [args])` → `f(args)`
//
// A `sh2.define("f", () => f(sh2.getVar("1"), …))` adapter keeps the
// shell dispatch working for any call site the pass didn't rewrite.
// Guards: the body must be await-free, the positional protocol must be
// a clean prefix, and no store var of the function may be written by
// another function mid-flight (a var written outside AND read inside is
// captured by the store init; a var written inside AND read outside is
// synced at the end — both faithful).

export function lowerPureFunctions(program) {
  // Fixpoint: a function whose only awaits are calls to ALREADY-lowered
  // functions becomes pure once the call sites are rewritten to direct
  // calls (get_cell awaits only map_get → round 2 lowers get_cell →
  // try_draw's exec("get_cell") becomes a direct call). Repeat until no
  // new functions qualify.
  let total = 0;
  for (let guard = 0; guard < 50; guard++) {
    const n = lowerPureRound(program);
    if (!n) break;
    total += n;
  }
  return program;
}

// The three shell→function call forms the A1 emitter can emit for a
// user function call:
//   sh2.exec("f", [args])            (async, legacy)
//   sh2.fnCall("f", [args])          (async or sync — the A1's common form)
//   sh2.callDirect("f", __fn_f, [args])  (sync direct — fn ref as arg 2)
// Returns { name, args } (the ArrayExpression elements) or null.
function shellFnCallInfo(call) {
  if (!call || call.type !== "CallExpression" || !call.callee || call.callee.type !== "MemberExpression" ||
      !call.callee.object || call.callee.object.type !== "Identifier" || call.callee.object.name !== "sh2" ||
      !call.callee.property || call.callee.property.type !== "Identifier" ||
      (call.callee.property.name !== "exec" && call.callee.property.name !== "fnCall" && call.callee.property.name !== "callDirect")) {
    return null;
  }
  if (!call.arguments || call.arguments.length < 2 || !call.arguments[0] ||
      call.arguments[0].type !== "Literal" || typeof call.arguments[0].value !== "string") return null;
  const argIdx = call.callee.property.name === "callDirect" ? 2 : 1;
  const argsArr = call.arguments[argIdx];
  if (argsArr && argsArr.type !== "ArrayExpression") return null;
  return { name: String(call.arguments[0].value), args: argsArr ? argsArr.elements : [] };
}

// ── safeWordListCoercion: the A1 word-split (`X.split(/\s+/)
// .filter(w => w.length > 0)` — the shell's unquoted-expansion split on a
// dispatch arg) is emitted on the RAW var — for a NUMBER (a native loop
// counter like the game's `tex_bg_done $sm_bg_i` after the numeric loop
// lowering) Number.split is not a function → the dispatch crashes. bash's
// word-split coerces the value to a string FIRST, so wrap the base in
// String(). The directShellFnCalls unwrap then strips it for direct calls;
// non-direct calls (fnCall/exec on functions the pass doesn't know, e.g.
// the tex_bg_* helpers nested inside setup_webgl's registration) keep the
// safe coercion.
export function safeWordListCoercion(program) {
  const isStringSafe = (b) =>
    !b || b.type === "StringLiteral" || b.type === "TemplateLiteral" ||
    (b.type === "CallExpression" && b.callee && b.callee.type === "Identifier" && b.callee.name === "String");
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
        n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === "split" &&
        n.arguments && n.arguments.length) {
      const base = n.callee.object;
      if (!isStringSafe(base)) {
        n.callee.object = {
          type: "CallExpression",
          callee: { type: "Identifier", name: "String" },
          arguments: [base],
          optional: false,
        };
      }
    }
    for (const k of Object.keys(n)) if (k !== "loc") walk(n[k]);
  };
  walk(program);
  return program;
}

// ── paramLiveValue: the `${v#pat}` strip forms transpile to
// `sh2.param("#", "v", pat)` with NO live value — the runtime reads the
// STORE, which a module-lifted var (`let v`) never writes → the strip
// returns "" and any parse built on it empties (the game's texture
// payload: `lt_s=${lt_s#?}` kept erasing the TSV to a bare newline).
// Append the live identifier as a 4th arg (the slice form already
// carries it); the runtime's param falls back to it when the store is
// empty. The op may be a Literal ("#") or, for a dynamic pattern, an
// Identifier — only the literal ops are the strip forms.
export function paramLiveValue(program) {
  const STRIP_OPS = new Set(["#", "##", "%", "%%"]);
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
        n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
        n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === "param" &&
        n.arguments && n.arguments.length >= 2 && n.arguments[0] && n.arguments[0].type === "Literal" &&
        STRIP_OPS.has(n.arguments[0].value)) {
      const name = n.arguments[1];
      let live = null;
      if (name && name.type === "Identifier") live = name;
      else if (name && name.type === "Literal" && typeof name.value === "string") live = { type: "Identifier", name: name.value };
      if (live && n.arguments.length < 4 && !n.arguments.some((a) => a.type === "Identifier" && a.name === live.name)) {
        n.arguments.push(live);
      }
    }
    for (const k of Object.keys(n)) if (k !== "loc") walk(n[k]);
  };
  walk(program);
  return program;
}

// ── directShellFnCalls: rewrite dispatch call sites of the NORMALIZED
// shell functions to direct JS calls ─────────────────────────────────
//
// normalizeFunctions (estree.js) converts `sh2.functions.set("f",
// arrow)` registrations into native `function f(...)` declarations — but
// leaves every CALL SITE as `await sh2.fnCall("f", [args])` (or the
// sync `sh2.callDirect("f", __fn_f, [args])`), which pays the runtime
// dispatch (function-table lookup, scriptArgs save/restore, argument
// stringifying, a Promise) per call. The texture generators call the
// pure helpers (lat_hash / smooth_w / vnoise2) thousands of times per
// texture; the dispatch is the measured hot cost.
//
// The pass collects the FunctionDeclaration names + async flags and
// rewrites every exec/fnCall/callDirect of a known function to a direct
// call: `await f(args)` for async targets, `f(args)` for sync. Output
// vars stay module-level (normalizeFunctions' design), so the direct
// call is semantically identical to the dispatch+adapter path.
// Functions whose body has an explicit `return N` keep the dispatch
// (the adapter propagates $? — the conservative fallback).
export function directShellFnCalls(program) {
  if (!program || program.type !== "Program" || !Array.isArray(program.body)) return program;
  const fns = new Map(); // name → { async, hasReturn, posRefs }
  for (const st of program.body) {
    if (!st || st.type !== "FunctionDeclaration" || !st.id || st.id.type !== "Identifier") continue;
    let hasReturn = false;
    let posRefs = false;
    let inLoopBody = 0;
    let canThrowReturn = false;
    const scan = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { for (const x of n) scan(x); return; }
      if (n.type === "ReturnStatement") {
        hasReturn = true;
        if (inLoopBody > 0) canThrowReturn = true;
      }
      // returnInLoop has ALREADY converted a `return N` inside a loop
      // body into a `sh2.return(N)` CALL (not a ReturnStatement) by the
      // time this pass runs — flag it exactly like a ReturnStatement, or
      // canThrowReturn stays false and the direct call's ReturnSignal
      // escapes to the top (claim_treasure's return 0 silently ended the
      // game the frame the first treasure was claimed — the signal was
      // unwrapped by exec("main") as main's own return value).
      if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
          n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
          n.callee.property && n.callee.property.type === "Identifier" &&
          n.callee.property.name === "return") {
        hasReturn = true;
        if (inLoopBody > 0) canThrowReturn = true;
      }
      // NATIVE loop statements (While/For/DoWhile) — this pass runs
      // BEFORE reclassAsyncLoops lowers them to sh2.whileLoop calls, so
      // the twin-detection below never fires for the game's loops; the
      // return_in_loop conversion's ReturnSignal throws from the NATIVE
      // body too. Track the body depth the same way.
      if (n.type === "WhileStatement" || n.type === "ForStatement" || n.type === "DoWhileStatement") {
        for (const k of Object.keys(n)) if (k !== "loc" && k !== "body" && k !== "test") scan(n[k]);
        if (n.test) scan(n.test);
        inLoopBody++;
        scan(n.body);
        inLoopBody--;
        return;
      }
      // the sh2 loop twins' BODY arrow (arguments[1]) is where the
      // return_in_loop conversion throws the ReturnSignal. The arrow is a
      // NESTED function (the $1..$9 check below skips nested functions) —
      // descend INTO its body block directly or the loop's returns are
      // never seen and canThrowReturn stays false (claim_treasure's
      // return 0 ended the game the frame the first treasure was
      // claimed — the signal was unwrapped by exec("main") as main's own
      // return value).
      if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
          n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
          n.callee.property && n.callee.property.type === "Identifier" &&
          /^(whileLoop|whileLoopSync|forLoop)$/.test(n.callee.property.name) &&
          n.arguments && n.arguments.length > 1) {
        scan(n.arguments[0]);
        inLoopBody++;
        if (n.arguments[1] &&
            (n.arguments[1].type === "ArrowFunctionExpression" || n.arguments[1].type === "FunctionExpression") &&
            n.arguments[1].body) {
          scan(n.arguments[1].body);
        } else {
          scan(n.arguments[1]);
        }
        inLoopBody--;
        for (const k of Object.keys(n)) if (k !== "loc" && k !== "arguments") scan(n[k]);
        return;
      }
      // a NESTED function's `$1..$9` are ITS OWN positionals (its own
      // dispatch sets them) — only the outer body's refs matter for the
      // direct-call wrapper, so don't descend
      if ((n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" || n.type === "FunctionDeclaration") && n !== st) return;
      if (n.type === "MemberExpression" && n.computed === false &&
          n.object && n.object.type === "Identifier" && n.object.name === "sh2" &&
          n.property && n.property.type === "Identifier" && n.property.name === "positional") posRefs = true;
      for (const k of Object.keys(n)) if (k !== "loc") scan(n[k]);
    };
    scan(st.body);
    fns.set(st.id.name, { async: !!st.async, hasReturn, posRefs, canThrowReturn });
  }
  if (!fns.size) return program;

  const isCall = (n, obj, fn) =>
    n && n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
    n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === obj &&
    n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === fn;
  // The dispatch's args are word-LIST coerced (`X.split(/\s+/)
  // .filter(w => w.length > 0)` — the shell's unquoted-expansion split);
  // the native function's params are plain STRINGS (the adapter passes
  // sh2.positional[N]), so unwrap the split back to the raw string.
  // `String(x).split(...)` → x; `(sh2.vars.x ?? "").split(...)` → the
  // store read.
  const unwrapWordList = (n) => {
    if (!n || n.type !== "CallExpression" || !n.callee || n.callee.type !== "MemberExpression" ||
        !n.callee.property || n.callee.property.type !== "Identifier" || n.callee.property.name !== "filter" ||
        !n.arguments || n.arguments.length !== 1) return n;
    const split = n.callee.object;
    if (!split || split.type !== "CallExpression" || !split.callee || split.callee.type !== "MemberExpression" ||
        !split.callee.property || split.callee.property.type !== "Identifier" || split.callee.property.name !== "split" ||
        !split.arguments || !split.arguments.length) return n;
    let base = split.callee.object;
    // String(x).split(...) → x
    if (base && base.type === "CallExpression" && base.callee && base.callee.type === "Identifier" &&
        base.callee.name === "String" && base.arguments && base.arguments.length === 1) base = base.arguments[0];
    return base;
  };
  // the runtime's callDirect catches a ReturnSignal (the loop-body
  // return_in_loop conversion) + unwraps its value; a DIRECT call must
  // too, or the signal escapes to the top (the game's draw_char loop
  // crashes). Wrap only the canThrowReturn functions (the hot pure
  // helpers stay bare).
  const catchReturn = (inner) => ({
    type: "CallExpression",
    callee: {
      type: "ArrowFunctionExpression", async: false, params: [], expression: false,
      body: {
        type: "BlockStatement",
        body: [{
          type: "TryStatement",
          block: { type: "BlockStatement", body: [{ type: "ReturnStatement", argument: inner }] },
          handler: {
            type: "CatchClause", param: { type: "Identifier", name: "e" },
            body: {
              type: "BlockStatement",
              body: [{
                type: "IfStatement",
                test: {
                  type: "BinaryExpression", operator: "instanceof",
                  left: { type: "Identifier", name: "e" },
                  right: { type: "MemberExpression", computed: false, optional: false,
                    object: { type: "Identifier", name: "sh2" },
                    property: { type: "Identifier", name: "ReturnSignal" } },
                },
                consequent: { type: "BlockStatement", body: [{
                  type: "ReturnStatement",
                  argument: { type: "MemberExpression", computed: false, optional: false,
                    object: { type: "Identifier", name: "e" },
                    property: { type: "Identifier", name: "value" } },
                }] },
                alternate: { type: "BlockStatement", body: [{
                  type: "ThrowStatement", argument: { type: "Identifier", name: "e" },
                }] },
              }],
            },
          },
          finalizer: null,
        }],
      },
    },
    arguments: [],
  });
  const directStmt = (info) => {
    const f = fns.get(info.name);
    const args = info.args.map((a) => rewrite(unwrapWordList(a)));
    const callExpr = {
      type: "CallExpression",
      callee: { type: "Identifier", name: info.name },
      arguments: args,
      optional: false,
    };
    let expr = callExpr;
    if (f.hasReturn && !f.posRefs) {
      // hasReturn target: the dispatch's `$?` contract is lastExit =
      // Number(return-value) (false → 1) — emulate it on the direct
      // call so the transformation is EXACTLY dispatch-equivalent even
      // when a later statement reads $?. The game's call sites discard
      // the result and overwrite lastExit right after, but the emulation
      // keeps the pass general (can_step/cell_visible/try_draw/… return
      // "0"/"1" verdicts through the STORE vars, not $?).
      const r = { type: "Identifier", name: "__r" };
      const sh2LastExit = () => ({
        type: "MemberExpression", computed: false, optional: false,
        object: { type: "Identifier", name: "sh2" },
        property: { type: "Identifier", name: "lastExit" },
      });
      const typeofR = (lit) => ({
        type: "BinaryExpression", operator: "===",
        left: { type: "UnaryExpression", operator: "typeof", prefix: true, argument: r },
        right: { type: "Literal", value: lit },
      });
      const inner = f.async ? { type: "AwaitExpression", argument: callExpr } : callExpr;
      expr = {
        type: "CallExpression",
        callee: {
          type: "ArrowFunctionExpression", async: !!f.async, params: [], expression: false, generator: false,
          body: {
            type: "BlockStatement",
            body: [
              { type: "VariableDeclaration", kind: "const", declarations: [
                { type: "VariableDeclarator", id: r, init: inner },
              ] },
              { type: "ExpressionStatement", expression: {
                type: "AssignmentExpression", operator: "=", left: sh2LastExit(),
                right: {
                  type: "ConditionalExpression",
                  test: { type: "LogicalExpression", operator: "||", left: typeofR("string"), right: typeofR("number") },
                  consequent: { type: "CallExpression", callee: { type: "Identifier", name: "Number" }, arguments: [r] },
                  alternate: {
                    type: "ConditionalExpression",
                    test: { type: "BinaryExpression", operator: "===", left: r, right: { type: "Literal", value: false } },
                    consequent: { type: "Literal", value: 1 },
                    alternate: { type: "Literal", value: 0 },
                  },
                },
              } },
            ],
          },
        },
        arguments: [],
      };
      if (f.async) expr = { type: "AwaitExpression", argument: expr };
    } else if (f.posRefs) {
      // the callee reads `$5..$9` via `sh2.positional[N]` — the runtime
      // dispatch sets that array for the call, so the DIRECT call must
      // too (and restore the caller's positionals after, exactly like
      // callDirect). Without it the HUD/menu rects lose their colour
      // (the device skips <7-number rect lines → invisible text).
      const prev = { type: "Identifier", name: "prevArgs" };
      const sh2Pos = () => ({
        type: "MemberExpression", computed: false, optional: false,
        object: { type: "Identifier", name: "sh2" },
        property: { type: "Identifier", name: "positional" },
      });
      const call = f.async ? { type: "AwaitExpression", argument: callExpr } : callExpr;
      expr = {
        type: "CallExpression",
        callee: {
          type: "ArrowFunctionExpression", async: !!f.async, params: [], expression: false, generator: false,
          body: {
            type: "BlockStatement",
            body: [
              { type: "VariableDeclaration", kind: "const", declarations: [
                { type: "VariableDeclarator", id: prev, init: sh2Pos() },
              ] },
              { type: "ExpressionStatement", expression: {
                type: "AssignmentExpression", operator: "=", left: sh2Pos(),
                right: { type: "ArrayExpression", elements: args },
              } },
              { type: "TryStatement",
                block: { type: "BlockStatement", body: [{ type: "ReturnStatement", argument: call }] },
                handler: null,
                finalizer: { type: "BlockStatement", body: [
                  { type: "ExpressionStatement", expression: {
                    type: "AssignmentExpression", operator: "=", left: sh2Pos(), right: prev,
                  } },
                ] },
              },
            ],
          },
        },
        arguments: [],
      };
      if (f.async) expr = { type: "AwaitExpression", argument: expr };
    } else if (f.async) {
      expr = { type: "AwaitExpression", argument: callExpr };
    }
    if (f.canThrowReturn) expr = catchReturn(expr);
    return { type: "ExpressionStatement", expression: expr };
  };
  const rewrite = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(rewrite);
    if (node.type === "ExpressionStatement" && node.expression) {
      let e = node.expression;
      if (isCall(e, "sh2", "guard") && e.arguments && e.arguments.length === 1) e = e.arguments[0];
      if (e && e.type === "AwaitExpression") {
        const inner = rewrite(e);
        if (inner && inner.type === "ExpressionStatement") return inner;
        // `await sh2.fnCall(...)` of a RETURNING function as a whole
        // statement: the dispatch result is discarded (the game's calls
        // set a STORE var; the next test overwrites $? anyway) — convert
        // it to a direct call with the dispatch's $? emulation. Value-
        // position awaits stay dispatched (their result is consumed).
        const ainfo = shellFnCallInfo(e.argument);
        if (ainfo && fns.has(ainfo.name)) {
          const af = fns.get(ainfo.name);
          if (af.hasReturn && !af.posRefs) return directStmt(ainfo);
        }
        return { type: "ExpressionStatement", expression: inner };
      }
      const info = shellFnCallInfo(e);
      if (info && fns.has(info.name)) {
        const f = fns.get(info.name);
        // a hasReturn target that also reads $1..$9 via the positional
        // bridge keeps the runtime dispatch (the direct wrapper cannot
        // both bridge positionals AND carry the return value) — rare
        // (HUD/menu rect helpers), not on the hot path.
        if (!(f.hasReturn && f.posRefs)) return directStmt(info);
      }
      return { type: "ExpressionStatement", expression: rewrite(node.expression) };
    }
    if (node.type === "AwaitExpression" && node.argument && node.argument.type === "CallExpression") {
      const info = shellFnCallInfo(node.argument);
      if (info && fns.has(info.name) && !fns.get(info.name).hasReturn) return directStmt(info);
      // an ALREADY-DIRECT call to a canThrowReturn function — the wasm
      // compile head performs the direct-call rewrite too (the game's
      // AST arrives with `await claim_treasure(...)` in place), but that
      // rewrite predates the catchReturn wrapper, so a loop-return's
      // ReturnSignal escapes the direct call and is unwrapped by the
      // NEXT exec() as THAT function's return value — for claim_treasure
      // the next exec is exec("main"), which silently ended the game the
      // frame the first treasure was claimed. Wrap it like directStmt
      // would have.
      if (node.argument.callee && node.argument.callee.type === "Identifier" &&
          fns.has(node.argument.callee.name) && fns.get(node.argument.callee.name).canThrowReturn) {
        return catchReturn(node);
      }
    }
    const out = {};
    for (const k of Object.keys(node)) out[k] = rewrite(node[k]);
    return out;
  };
  program.body = program.body.map(rewrite);
  return program;
}

// ── liftLocalVars: promote single-function store locals to native
// bindings + drop dead param-sync writes ───────────────────────────
//
// The A1's typed lowering lifts the vars it proves safe to module-level
// `let` declarators; everything else round-trips through the runtime
// store (`sh2.setVar("v", …)` writes + `sh2.vars.v` reads — a Proxy
// trap + an env-fallback chain per access). Every shell function also
// writes its PARAMS to the store on entry (`sh2.setVar("a", a)` — the
// param-sync) even when the body never re-reads them from the store.
// The game's per-frame helpers (cell_visible's cv_deg/cv_cs/cv_sn, the
// maze-gen map_get) pay that round-trip on every call.
//
// Two safe rewrites:
//   A) param-sync drop: `sh2.setVar("p", p)` where p is a native param
//      and the body's ONLY store ops for p are those sync writes →
//      remove them (the body reads p natively; the store is untouched).
//   B) local lift: a store var v used in exactly ONE function F (and
//      nowhere at top level), written there with a WRITE as its first
//      mention, never a module `let`, never an array (setArray /
//      element-write / arrayIndex read) or string-indirected (dynamic
//      setVar/getVar names, sh2.param) → rewrite F's store ops for v to
//      a bare identifier and declare `let v = ""` at module level (the
//      store's default; a written var shadows the env fallback, and the
//      module-level let preserves the store's cross-call persistence).
export function liftLocalVars(program) {
  if (!program || program.type !== "Program" || !Array.isArray(program.body)) return program;
  const moduleLets = new Set();
  for (const st of program.body) {
    if (st && st.type === "VariableDeclaration" && st.kind === "let" && st.declarations) {
      for (const d of st.declarations) if (d.id && d.id.type === "Identifier") moduleLets.add(d.id.name);
    }
  }
  const isCall = (n, obj, fn) =>
    n && n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
    n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === obj &&
    n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === fn;
  const identName = (n) => (n && n.type === "Identifier" ? n.name : null);
  const isVarsMember = (n) =>
    n && n.type === "MemberExpression" && !n.computed &&
    n.object && n.object.type === "MemberExpression" && !n.object.computed &&
    n.object.object && n.object.object.type === "Identifier" && n.object.object.name === "sh2" &&
    n.object.property && n.object.property.type === "Identifier" && n.object.property.name === "vars" &&
    n.property && n.property.type === "Identifier";

  // per-scope store usage: { reads, writes, syncs, arrays, indirect, ops }
  const scopes = new Map();
  const stringRefs = new Set(); // program-wide: vars named in "$x" string args
  const newScope = () => ({ reads: new Set(), writes: new Set(), syncs: new Set(), arrays: new Set(), indirect: new Set(), ops: [] });
  const scan = (body, scope) => {
    const walk = (n, parent, key) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { for (const x of n) walk(x, parent, key); return; }
      // sh2.setVar / setArray / getVar / param / arrayIndex / vars.x
      if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
          n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2") {
        const fn = n.callee.property && n.callee.property.type === "Identifier" ? n.callee.property.name : "";
        const a0 = n.arguments && n.arguments[0];
        // a var referenced by NAME inside a STRING-LITERAL arg of a runtime
        // call ("$x" / "arr[$x]") is READ FROM THE STORE by the runtime
        // (arrayIndex/setVar/test expand "$x" via getVar) — lifting it to a
        // JS binding would leave the store empty and the expansion resolves
        // to "". Templates (`arr[${x}]`) are JS-evaluated, so only literal
        // strings count. Scanned FIRST (the per-function handlers return).
        for (const a of n.arguments) {
          if (a && a.type === "Literal" && typeof a.value === "string") {
            const sm = String(a.value).match(/\$([A-Za-z_][A-Za-z0-9_]*)/g);
            if (sm) for (const mm of sm) stringRefs.add(mm.slice(1));
          }
        }
        if (fn === "setVar" && a0) {
          if (a0.type === "Literal" && typeof a0.value === "string") {
            const nm = a0.value;
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) {
              const val = n.arguments[1];
              const isSync = val && val.type === "Identifier" && val.name === nm;
              if (isSync) scope.syncs.add(nm); else scope.writes.add(nm);
              scope.ops.push({ name: nm, kind: isSync ? "sync" : "write", node: n, parent, key });
            } else scope.indirect.add(nm);
          } else if (a0.type === "TemplateLiteral") {
            const q = a0.quasis && a0.quasis[0] && a0.quasis[0].value && a0.quasis[0].value.raw;
            if (q && /^[A-Za-z_][A-Za-z0-9_]*\[$/.test(q)) {
              const nm = q.slice(0, -1); scope.arrays.add(nm);
              scope.ops.push({ name: nm, kind: "write", node: n, parent, key });
            }
          } else scope.indirect.add("*");
          return;
        }
        if (fn === "setArray" && a0 && a0.type === "Literal" && typeof a0.value === "string") {
          scope.arrays.add(a0.value);
          scope.ops.push({ name: a0.value, kind: "write", node: n, parent, key });
          return;
        }
        if (fn === "getVar" && a0 && a0.type === "Literal" && typeof a0.value === "string") {
          scope.reads.add(a0.value);
          scope.ops.push({ name: a0.value, kind: "read", node: n, parent, key });
          return;
        }
        if (fn === "getVar" && a0 && a0.type !== "Literal") { scope.indirect.add("*"); return; }
        if (fn === "param") {
          for (const a of n.arguments) if (a.type === "Literal" && typeof a.value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a.value)) scope.indirect.add(a.value);
          return;
        }
        if (fn === "arrayIndex" && a0 && a0.type === "Literal" && typeof a0.value === "string") {
          scope.arrays.add(a0.value);
          scope.ops.push({ name: a0.value, kind: "read", node: n, parent, key });
          return;
        }
      }
      if (isVarsMember(n)) {
        const nm = n.property.name;
        const isWrite = parent && parent.type === "AssignmentExpression" && parent.left === n;
        const kind = isWrite ? "write" : "read";
        (kind === "write" ? scope.writes : scope.reads).add(nm);
        scope.ops.push({ name: nm, kind, node: n, parent, key });
        return; // the vars.x chain is fully consumed
      }
      if (n.type === "MemberExpression" && n.computed &&
          n.object && n.object.type === "MemberExpression" &&
          n.object.object && n.object.object.type === "Identifier" && n.object.object.name === "sh2" &&
          n.object.property && n.object.property.type === "Identifier" && n.object.property.name === "vars") {
        scope.indirect.add("*");
        return;
      }
      for (const k of Object.keys(n)) if (k !== "loc") walk(n[k], n, k);
    };
    for (const st of body) walk(st, null, null);
  };
  for (const st of program.body) {
    if (st && st.type === "FunctionDeclaration" && st.id) {
      const s = newScope();
      s.params = new Set((st.params || []).filter((p) => p && p.type === "Identifier").map((p) => p.name));
      scan(st.body ? st.body.body : [], s);
      scopes.set(st.id.name, s);
    } else if (st && st.type === "ExpressionStatement" && st.expression &&
               st.expression.type === "CallExpression" && st.expression.callee && st.expression.callee.type === "MemberExpression" &&
               st.expression.callee.object && st.expression.callee.object.type === "MemberExpression" &&
               st.expression.callee.object.object && st.expression.callee.object.object.type === "Identifier" && st.expression.callee.object.object.name === "sh2" &&
               st.expression.callee.object.property && st.expression.callee.object.property.type === "Identifier" && st.expression.callee.object.property.name === "functions" &&
               st.expression.callee.property && st.expression.callee.property.type === "Identifier" && st.expression.callee.property.name === "set" &&
               st.expression.arguments && st.expression.arguments[0] && st.expression.arguments[0].type === "Literal" &&
               st.expression.arguments[1] && st.expression.arguments[1].type === "ArrowFunctionExpression") {
      // a `sh2.functions.set("name", async () => { … })` registration — the
      // A1's async functions that stay dispatch-bound (called via exec).
      // Treat the arrow as a function scope (its store vars lift like any
      // other function's).
      const rname = String(st.expression.arguments[0].value);
      if (scopes.has(rname)) continue; // the FunctionDeclaration wins
      const arrow = st.expression.arguments[1];
      const s = newScope();
      s.params = new Set((arrow.params || []).filter((p) => p && p.type === "Identifier").map((p) => p.name));
      scan(arrow.body && arrow.body.type === "BlockStatement" ? arrow.body.body : [], s);
      scopes.set(rname, s);
    }
  }
  // the top level excludes the function scopes AND the registration
  // arrows (they are their own scopes — descending would mark every
  // arrow var as a top-level use and kill the lift)
  const isRegistration = (st) => st && st.type === "ExpressionStatement" && st.expression &&
    st.expression.type === "CallExpression" && st.expression.callee && st.expression.callee.type === "MemberExpression" &&
    st.expression.callee.object && st.expression.callee.object.type === "MemberExpression" &&
    st.expression.callee.object.object && st.expression.callee.object.object.type === "Identifier" && st.expression.callee.object.object.name === "sh2" &&
    st.expression.callee.object.property && st.expression.callee.object.property.type === "Identifier" && st.expression.callee.object.property.name === "functions" &&
    st.expression.callee.property && st.expression.callee.property.type === "Identifier" && st.expression.callee.property.name === "set";
  const top = newScope();
  top.params = new Set();
  scan(program.body.filter((st) => !(st && (st.type === "FunctionDeclaration" || isRegistration(st)))), top);
  scopes.set("__top", top);

  // single-function usage: v is used in exactly one NON-top scope
  const usageCount = new Map();
  for (const [name, s] of scopes) {
    if (name === "__top") continue;
    for (const v of s.ops.map((o) => o.name)) usageCount.set(v, (usageCount.get(v) || 0) + 1);
  }
  const topUses = new Set(top.ops.map((o) => o.name).concat([...top.indirect]));

  // decide lifts per function
  const lifts = new Map(); // fn name → Set of lifted var names
  const syncDrops = new Map(); // fn name → Set of param names whose syncs are dropped
  // program-wide first mention per var (statement order across all scopes):
  // the module let starts "" — a READ before the first write would see the
  // default where the store proxy might have fallen back to the shell env.
  const globalFirst = new Map();
  for (const [, s] of scopes) {
    for (const o of s.ops) if (!globalFirst.has(o.name)) globalFirst.set(o.name, o.kind);
  }
  for (const [name, s] of scopes) {
    if (name === "__top") continue;
    const lifted = new Set();
    for (const v of s.ops.map((o) => o.name)) {
      if (s.arrays.has(v) || s.indirect.has(v) || s.indirect.has("*") || topUses.has(v)) continue;
      // note: vars named in "$v" string args are NOT excluded here — the
      // post-lift interpolation converts those strings to ${v} templates
      // (the runtime's store expansion would answer ""), so the lift stays
      // safe AND the array-index keys become JS-evaluated.
      if (moduleLets.has(v)) continue;
      // a var used in MANY functions is fine — the module let is the
      // store's scope, so cross-function sharing still resolves (the
      // single-function guard was for function-local lets, which we no
      // longer use). What matters is the global first mention + writes.
      if (!s.writes.has(v)) continue; // written at least once (shadows env)
      const first = s.ops.find((o) => o.name === v);
      if (!first || first.kind === "read") continue; // write-first in this function
      if (globalFirst.get(v) === "read") continue; // and program-wide
      if (s.params.has(v)) continue; // params are native already
      lifted.add(v);
    }
    if (lifted.size) lifts.set(name, lifted);
    // A) param-sync drop: a param whose ONLY store ops are its syncs (and
    // that is never read by name from a "$p" string — the runtime would
    // resolve the empty store)
    const drop = new Set();
    for (const p of s.params) {
      if (stringRefs.has(p)) continue;
      const ops = s.ops.filter((o) => o.name === p);
      if (ops.length && ops.every((o) => o.kind === "sync")) drop.add(p);
    }
    if (drop.size) syncDrops.set(name, drop);
  }
  if (!lifts.size && !syncDrops.size) return program;
  // rewrite
  const id = (name) => ({ type: "Identifier", name });
  const isChainRead = (n) =>
    n && n.type === "LogicalExpression" && n.operator === "??" && isVarsMember(n.left);
  // the module lets are the SHARED cross-function binding: a var lifted in
  // ONE function (the write-first owner) must have its STORE reads/writes
  // converted to the native binding in EVERY function that touches it —
  // a read-only function (e.g. draw_text reading `gi` that glyph_index
  // writes) would otherwise keep reading `sh2.vars.gi` — the store never
  // gets the value → "" → the glyph always rendered as the first char.
  const liftedAll = new Set();
  for (const [, lf] of lifts) for (const v of lf) liftedAll.add(v);
  for (const [name, s] of scopes) {
    if (name === "__top") continue;
    const lifted = new Set(liftedAll);
    const drop = syncDrops.get(name) || new Set();
    // process a function when it has a write-lift OR drops OR touches any
    // module-lifted var (a read-only consumer needs the read conversion)
    const touchesLifted = (s.ops || []).some((o) => liftedAll.has(o.name));
    if (!lifted.size && !drop.size && !touchesLifted) continue;
    // the per-function body may be a FunctionDeclaration OR a
    // `sh2.functions.set("name", async () => { … })` registration (the
    // otranspilerl compile path emits the latter) — find whichever
    // carries the body so the write-lift actually lands (a lift with a
    // missing write leaves the reads interpolated against an undefined
    // JS binding — the game's `glsl` test crashed emit_vertex_shader).
    let fn = null, fnBodyArr = null, regArrow = null;
    const fd = program.body.find((st) => st && st.type === "FunctionDeclaration" && st.id && st.id.name === name);
    if (fd && fd.body && fd.body.type === "BlockStatement" && Array.isArray(fd.body.body)) { fn = fd; fnBodyArr = fd.body.body; }
    if (!fnBodyArr) {
      for (const st of program.body) {
        if (!st || st.type !== "ExpressionStatement" || !st.expression || st.expression.type !== "CallExpression") continue;
        const callee = st.expression.callee;
        if (!callee || callee.type !== "MemberExpression" || !callee.property || callee.property.type !== "Identifier" ||
            callee.property.name !== "set" || !callee.object || callee.object.type !== "MemberExpression" ||
            !callee.object.object || callee.object.object.type !== "Identifier" || callee.object.object.name !== "sh2" ||
            !callee.object.property || callee.object.property.type !== "Identifier" || callee.object.property.name !== "functions") continue;
        const args = st.expression.arguments || [];
        if (args.length >= 2 && args[0] && args[0].type === "Literal" && args[0].value === name &&
            args[1] && (args[1].type === "ArrowFunctionExpression" || args[1].type === "FunctionExpression") &&
            args[1].body && args[1].body.type === "BlockStatement" && Array.isArray(args[1].body.body)) {
          fnBodyArr = args[1].body.body;
          regArrow = args[1];
          break;
        }
      }
    }
    if (!fnBodyArr) continue;
    const newBody = [];
    for (const st of fnBodyArr) {
      const walk = (n, parent, key) => {
        if (!n || typeof n !== "object") return n;
        if (Array.isArray(n)) return n.map((x) => walk(x, n, key));
        // 1) the `(sh2.vars.v ?? (sh2.env.v ?? ""))` chain → v
        if (isChainRead(n)) {
          const v = n.left.property.name;
          if (lifted.has(v)) return id(v);
        }
        // 2) bare sh2.vars.v read / assignment target → v
        if (isVarsMember(n)) {
          const v = n.property.name;
          if (lifted.has(v)) return id(v);
        }
        // 3) sh2.setVar("v", X) → v = X ; sync drops → remove
        if (isCall(n, "sh2", "setVar") && n.arguments && n.arguments[0]) {
          const a0 = n.arguments[0];
          if (a0.type === "Literal" && typeof a0.value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a0.value)) {
            const v = a0.value;
            if (drop.has(v) && n.arguments[1] && n.arguments[1].type === "Identifier" && n.arguments[1].name === v) return null; // dead sync
            if (lifted.has(v)) {
              return {
                type: "AssignmentExpression", operator: "=",
                left: id(v), right: walk(n.arguments[1], n, "arguments"),
              };
            }
          }
        }
        // 4) sh2.getVar("v") → v
        if (isCall(n, "sh2", "getVar") && n.arguments && n.arguments[0] && n.arguments[0].type === "Literal" &&
            typeof n.arguments[0].value === "string" && lifted.has(n.arguments[0].value)) return id(n.arguments[0].value);
        const out = {};
        for (const k of Object.keys(n)) if (k !== "loc") out[k] = walk(n[k], n, k);
        return out;
      };
      const rewritten = walk(st, null, null);
      if (rewritten === null) continue;
      if (rewritten && rewritten.type === "ExpressionStatement" && rewritten.expression &&
          rewritten.expression.type === "SequenceExpression") {
        const kept = (rewritten.expression.expressions || []).filter(Boolean);
        if (kept.length) {
          const s2 = { type: "SequenceExpression", expressions: kept };
          newBody.push({ type: "ExpressionStatement", expression: s2 });
        }
        continue;
      }
      newBody.push(rewritten);
    }
    if (regArrow) regArrow.body.body = newBody; else fn.body.body = newBody;
  }
  // declare the lifted vars at module level (`let v = ""` — the store's
  // default; preserves cross-call persistence like the store)
  const newLets = [];
  const seenLets = new Set();
  for (const [, lifted] of lifts) for (const v of lifted) if (!seenLets.has(v)) { seenLets.add(v); newLets.push(v); }
  if (newLets.length) {
    newLets.sort();
    program.body.unshift({
      type: "VariableDeclaration", kind: "let", declarations: newLets.map((v) => ({
        type: "VariableDeclarator", id: id(v), init: { type: "Literal", value: "" },
      })),
    });
  }
  // post-lift: the runtime reads "$name" string args (arrayIndex/setVar/
  // test/param) FROM THE STORE — a lifted var's store is never written, so
  // the expansion would resolve to "". Rewrite every "$lifted" token to a
  // ${lifted} interpolation (same contract the counter promotion uses), so
  // the value travels with the call. ONE program walk over ALL the lifted
  // names (the per-name rewriteCounterRefs loop was O(names × program) —
  // ~8s of the mimecroft transpile).
  const allLifted = new Set();
  for (const lifted of lifts.values()) for (const v of lifted) allLifted.add(v);
  if (allLifted.size) {
    const names = [...allLifted];
    const walkInterp = (n) => {
      if (!n || typeof n !== "object") return n;
      if (Array.isArray(n)) return n.map(walkInterp);
      if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
          n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
          n.callee.property && n.callee.property.type === "Identifier" &&
          (n.callee.property.name === "arrayIndex" || n.callee.property.name === "arrayLen" || n.callee.property.name === "param")) {
        const out = { ...n };
        out.arguments = (n.arguments || []).map((a) =>
          a && a.type === "Literal" && typeof a.value === "string" && a.value.startsWith("$") &&
          allLifted.has(a.value.slice(1))
            ? { type: "Identifier", name: a.value.slice(1) }
            : walkInterp(a));
        return out;
      }
      if (n.type === "Literal" && typeof n.value === "string") {
        let has = false;
        for (const nm of names) if (String(n.value).includes("$" + nm)) { has = true; break; }
        return has ? interpolateStringMulti(n, names) : n;
      }
      if (n.type === "TemplateLiteral") {
        let has = false;
        for (const q of n.quasis || []) {
          const t = q.value && (q.value.cooked != null ? q.value.cooked : q.value.raw);
          if (t != null) for (const nm of names) if (String(t).includes("$" + nm)) { has = true; break; }
          if (has) break;
        }
        if (has) return interpolateTemplateMulti(n, names);
      }
      const out = {};
      for (const k of Object.keys(n)) if (k !== "loc") out[k] = walkInterp(n[k]);
      return out;
    };
    program.body = program.body.map(walkInterp);
  }
  return program;
}

// ── nativeArrays: fold store-backed arrays to native module bindings ──
//
// The game's per-frame arrays (map — the 205k maze-cell reads — an, the
// animation frames, GMASK, mime_lookup, …) live in the runtime store and
// every read pays `sh2.arrayIndex` (a function call + a Map.get + the
// expandOperand/coercion machinery). After liftLocalVars the index keys
// are JS-evaluated (templates/identifiers — the "$x" strings were
// interpolated), so a read becomes a plain array index.
//
// Eligibility (all must hold for an array A):
//   - initialized by `sh2.setArray("A", …)` (it IS an array, never a
//     scalar — a plain `sh2.setVar("A", …)` disqualifies);
//   - never read/written BY NAME elsewhere: getVar("A"), arrayLen("A"),
//     bare `sh2.vars.A`, "$A"/"${A[@]}" strings, mem handles, dynamic
//     computed names;
//   - every arrayIndex key and element-write index is JS-evaluated (no
//     "$x" string keys left — the runtime would expand them from the
//     store, which a native array no longer mirrors).
//
// Rewrites (the runtime's arrayIndex/setVar-element semantics):
//   setArray("A", e)        → A = (e || []).map(String)
//   arrayIndex("A", K)      → String((A || [])[Number(K)] ?? "")
//   setVar(`A[${K}]`, V)    → A[Number(K)] = (V == null ? "" : String(V))
// and `let A = []` is declared at module level (the store's missing-array
// read answers "", and `(A || [])` replicates it for reads before init).
export function nativeArrays(program) {
  if (!program || program.type !== "Program" || !Array.isArray(program.body)) return program;
  const moduleLets = new Set();
  for (const st of program.body) {
    if (st && st.type === "VariableDeclaration" && st.kind === "let" && st.declarations) {
      for (const d of st.declarations) if (d.id && d.id.type === "Identifier") moduleLets.add(d.id.name);
    }
  }
  const isCall = (n, obj, fn) =>
    n && n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
    n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === obj &&
    n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === fn;
  const isVarsMember = (n) =>
    n && n.type === "MemberExpression" && !n.computed &&
    n.object && n.object.type === "MemberExpression" && !n.object.computed &&
    n.object.object && n.object.object.type === "Identifier" && n.object.object.name === "sh2" &&
    n.object.property && n.object.property.type === "Identifier" && n.object.property.name === "vars" &&
    n.property && n.property.type === "Identifier";

  const arrays = new Map(); // name → { setArray: [], reads: [], writes: [], bad: Set }
  const get = (n) => { if (!arrays.has(n)) arrays.set(n, { setArray: [], reads: [], writes: [], bad: new Set() }); return arrays.get(n); };
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
        n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2") {
      const fn = n.callee.property && n.callee.property.type === "Identifier" ? n.callee.property.name : "";
      const a0 = n.arguments && n.arguments[0];
      const nameOf = (a) => (a && a.type === "Literal" && typeof a.value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a.value) ? a.value : null);
      // a mem handle (\u0001mem:<name>:<off>) — a C pointer into the array
      // <name> — the C frontend reads/writes the STORE array through it, so
      // the native conversion would orphan the pointer's writes
      const memTarget = (a) => {
        if (a && a.type === "Literal" && typeof a.value === "string" && /^\u0001mem:([A-Za-z_][A-Za-z0-9_]*):/.test(a.value)) {
          const mm = /^\u0001mem:([A-Za-z_][A-Za-z0-9_]*):/.exec(a.value);
          if (mm && arrays.has(mm[1])) get(mm[1]).bad.add("memHandle");
        }
      };
      if (fn === "setArray") { const nm = nameOf(a0); if (nm) get(nm).setArray.push(n); return; }
      if (fn === "arrayIndex") {
        memTarget(a0);
        const nm = nameOf(a0);
        if (nm) {
          const key = n.arguments && n.arguments[1];
          // a "$x" string key is a runtime store expansion — the native
          // array can't mirror it
          if (key && key.type === "Literal" && typeof key.value === "string" && key.value.includes("$")) get(nm).bad.add("stringKey");
          if (key && key.type === "Literal" && typeof key.value === "string" && !key.value.includes("$")) get(nm).reads.push(n);
          if (key && key.type === "TemplateLiteral") {
            // a template key with literal text beyond the interpolation
            // (e.g. `${i} + 1`) carries ARITH the runtime's expandOperand
            // evaluates — Number() can't — disqualify
            const quasis = key.quasis || [];
            for (let i = 0; i < quasis.length; i++) {
              const t = quasis[i] && quasis[i].value && (quasis[i].value.cooked != null ? quasis[i].value.cooked : quasis[i].value.raw);
              if (i === 0 && String(t || "") !== "") continue; // the opening ""
              if (i === quasis.length - 1 && String(t || "") !== "") continue;
              if (String(t || "") !== "") { get(nm).bad.add("arithKey"); break; }
            }
            get(nm).reads.push(n);
          }
          if (key && key.type === "Identifier") get(nm).reads.push(n);
          if (key && (key.type === "LogicalExpression" || key.type === "CallExpression" || key.type === "BinaryExpression" || key.type === "UnaryExpression")) get(nm).reads.push(n);
        } else if (a0 && a0.type === "Literal" && typeof a0.value === "string" && /^\u0001mem:/.test(a0.value)) {
          // a mem handle — never an eligible array
        }
        return;
      }
      if (fn === "setVar" && a0) {
        memTarget(a0);
        if (a0.type === "TemplateLiteral") {
          const q = a0.quasis && a0.quasis[0] && a0.quasis[0].value && a0.quasis[0].value.raw;
          if (q && /^[A-Za-z_][A-Za-z0-9_]*\[$/.test(q)) {
            const nm = q.slice(0, -1);
            if (arrays.has(nm)) get(nm).writes.push(n);
          }
        } else if (a0.type === "Literal" && typeof a0.value === "string") {
          const b = a0.value.lastIndexOf("[");
          const nm = b > 0 && a0.value.endsWith("]") ? a0.value.slice(0, b) : a0.value;
          if (arrays.has(nm)) {
            if (b > 0) get(nm).bad.add("literalElem");
            else get(nm).bad.add("plainSetVar"); // a scalar write of the array name
          }
        }
        // a setVar VALUE can embed a nested arrayIndex (e.g.
        // `setVar("rd_cs", arrayIndex("SCOS", "$rd_deg"))` — the wasm's
        // store-backed read). Descend so its "$x" string key marks the
        // array bad (the eligibility walk must see every array key the
        // rewrite walk folds, or a "$x" literal survives as Number("$x")
        // = NaN and the array's reads collapse to empty).
        for (const a of (n.arguments || []).slice(1)) walk(a);
        return;
      }
      if (fn === "getVar" && a0 && a0.type === "Literal" && typeof a0.value === "string" && arrays.has(a0.value)) { get(a0.value).bad.add("getVar"); return; }
      if (fn === "arrayLen" && a0 && a0.type === "Literal" && typeof a0.value === "string" && arrays.has(a0.value)) { get(a0.value).bad.add("arrayLen"); return; }
      if (fn === "param") {
        for (const a of n.arguments) if (a && a.type === "Literal" && typeof a.value === "string" && arrays.has(a.value)) get(a.value).bad.add("param");
        return;
      }
    }
    if (isVarsMember(n)) {
      const nm = n.property.name;
      if (arrays.has(nm)) get(nm).bad.add("varsBare");
      return;
    }
    if (n.type === "Literal" && typeof n.value === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*[@*]?$/.test(n.value)) {
      const nm = n.value.slice(1).replace(/[@*]$/, "");
      if (arrays.has(nm)) get(nm).bad.add("wholeStr");
      return;
    }
    for (const k of Object.keys(n)) if (k !== "loc") walk(n[k]);
  };
  walk(program);

  // an array whose name is ANY function's param (the C frontend's pointer
  // params — a/b/arr… — pass the array by name; a module let with the same
  // name would shadow the param and the pointer walk would read the empty
  // native binding). The game's arrays (map/mx/mz/GMASK…) are never params.
  const paramNames = new Set();
  const collectParams = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) collectParams(x); return; }
    if (n.type === "FunctionDeclaration" && n.params) for (const p of n.params) if (p && p.type === "Identifier") paramNames.add(p.name);
    if (n.type === "ArrowFunctionExpression" && n.params) for (const p of n.params) if (p && p.type === "Identifier") paramNames.add(p.name);
    for (const k of Object.keys(n)) if (k !== "loc") collectParams(n[k]);
  };
  collectParams(program);
  const eligible = [];
  for (const [nm, a] of arrays) {
    if (moduleLets.has(nm)) continue; // already a native binding (typed arrays)
    if (paramNames.has(nm)) continue; // a C pointer param (or any param)
    if (!a.setArray.length) continue;
    if (a.bad.size) continue;
    eligible.push(nm);
  }
  if (!eligible.length) return program;
  const elig = new Set(eligible);

  const id = (name) => ({ type: "Identifier", name });
  const lit = (v) => ({ type: "Literal", value: v });
  const num = (x) => ({
    type: "CallExpression", callee: { type: "Identifier", name: "Number" }, arguments: [x], optional: false,
  });
  const str = (x) => ({
    type: "CallExpression", callee: { type: "Identifier", name: "String" }, arguments: [x], optional: false,
  });
  const rewrite = (n) => {
    if (!n || typeof n !== "object") return n;
    if (Array.isArray(n)) return n.map(rewrite);
    if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
        n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2") {
      const fn = n.callee.property && n.callee.property.type === "Identifier" ? n.callee.property.name : "";
      const a0 = n.arguments && n.arguments[0];
      if (fn === "setArray" && a0 && a0.type === "Literal" && typeof a0.value === "string" && elig.has(a0.value)) {
        const elems = rewrite(n.arguments[1]);
        const mapCall = {
          type: "CallExpression",
          callee: { type: "MemberExpression", computed: false, optional: false, object: {
            type: "LogicalExpression", operator: "||", left: elems || { type: "ArrayExpression", elements: [] }, right: { type: "ArrayExpression", elements: [] },
          }, property: { type: "Identifier", name: "map" } },
          arguments: [{ type: "Identifier", name: "String" }], optional: false,
        };
        return { type: "AssignmentExpression", operator: "=", left: id(a0.value), right: mapCall };
      }
      if (fn === "arrayIndex" && a0 && a0.type === "Literal" && typeof a0.value === "string" && elig.has(a0.value)) {
        const K = rewrite(n.arguments[1]);
        const arr = { type: "LogicalExpression", operator: "||", left: id(a0.value), right: { type: "ArrayExpression", elements: [] } };
        const idx = { type: "MemberExpression", computed: true, optional: false, object: arr, property: num(K) };
        return str({ type: "LogicalExpression", operator: "??", left: idx, right: lit("") });
      }
      if (fn === "setVar" && a0 && a0.type === "TemplateLiteral" && elig.has((a0.quasis[0] && a0.quasis[0].value && a0.quasis[0].value.raw || "").split("[")[0])) {
        const nm = a0.quasis[0].value.raw.split("[")[0];
        const K = a0.expressions && a0.expressions[0] ? rewrite(a0.expressions[0]) : lit(0);
        const V = rewrite(n.arguments[1]);
        const val = {
          type: "ConditionalExpression",
          test: { type: "BinaryExpression", operator: "==", left: V, right: lit(null) },
          consequent: lit(""),
          alternate: str(V),
        };
        const target = { type: "MemberExpression", computed: true, optional: false, object: id(nm), property: num(K) };
        return { type: "AssignmentExpression", operator: "=", left: target, right: val };
      }
    }
    const out = {};
    for (const k of Object.keys(n)) if (k !== "loc") out[k] = rewrite(n[k]);
    return out;
  };
  program.body = program.body.map(rewrite);
  eligible.sort();
  program.body.unshift({
    type: "VariableDeclaration", kind: "let", declarations: eligible.map((nm) => ({
      type: "VariableDeclarator", id: id(nm), init: { type: "ArrayExpression", elements: [] },
    })),
  });
  return program;
}

// ── lowerI32Trunc: Math.trunc on a provably-int32 compound → trailing |0 ──
//
// Why this is specifically a win (measured, Node 24 — see
// docs/architectural-considerations.md § "JS arithmetic speed"):
//   • `Math.trunc(x / 1000)` — the SIMPLE constant-divisor division — is
//     already optimal: V8's magic-number division (multiply-high + shift)
//     handles the constant 1000, and `(x/1000)|0` is a wash (69 vs 58 M
//     ops/s — the |0's ToInt32 cancels the benefit).
//   • `Math.trunc(<compound> / y)` — the COMPOUND form (a product/sum
//     chain divided at the end, e.g. the render geometry
//     `(td_ddx*td_sn − td_ddz*td_cs)/1000` and the anim glide) — the JIT
//     keeps `Math.trunc` as a separate conversion sequence on the FP
//     chain, while the trailing `|0` uses the built-in ToInt32 conversion:
//     on the game's REAL emitted shapes the |0 forms measured 0–16%
//     faster (averaged interleaved rounds: cell 27.5 vs 23.7 M, glide
//     26.7 vs 24.8, render compound 22.6 vs 22.3) and never slower. (The
//     earlier "2.3×" figure was a single-run artifact on a loaded box —
//     the variable-divisor synthetic shape — it does not reproduce under
//     repeated interleaved measurement.)
//   • Correctness: `(X)|0` is ToInt32 — identity for values in
//     [−2^31, 2^31) AND truncates toward zero like Math.trunc (bash's
//     integer division). Outside that range it WRAPS — so the rewrite is
//     applied ONLY where the interval fold below proves the expression's
//     value stays in [−2^31, 2^31).
//
// The range proof: a conservative interval fold over literals + the
// arithmetic operators. Any leaf that isn't a bounded literal (a var
// read, a `(Number(v)||0)` coercion, an arrayIndex call — the game's
// compounds are full of them) is UNPROVABLE → the whole expression is
// skipped. So today the pass only fires where the compiler already knows
// the bounds (literal-only numerators — which the A1 usually constant-
// folds anyway). Covering the game's var compounds needs the A1-side i31
// range analysis (shir.rs can propagate the def bounds — the maze limits,
// the ×1000 scales — and emit `(N/D)|0` at the division render); this
// pass is the sound JS-side half + the place the A1 annotation would
// hook.
// ── nativeSharedScalars: fold cross-function shared scalars to the
//    module-level `let` bindings the transpiler already emits ──
//
// The game's discipline passes helper outputs through the runtime store:
// `sh2.setVar("gv", v)` writes and `sh2.vars.gv ?? (sh2.env.gv ?? "")`
// reads (map_get/hardness/block_color/… outputs, the frame-shared display
// vars rd_cs/rd_sn/dpcx_ms/…). Every round-trip is a Map get + a Proxy
// get + a nullish chain per ACCESS — the hot paths (try_draw's 768-cell
// cull, draw_char's glyph loop) do dozens per call. The module already
// declares `let gv = "" …` (the same bindings nativeArrays folds arrays
// into), so folding a scalar means: setVar("gv", v) → `gv = String(v)`
// and `sh2.vars.gv ?? (sh2.env.gv ?? "")` → `gv` — no store, no Proxy,
// no nullish chain. Mirrors nativeArrays' eligibility discipline: a
// symbol folds only when EVERY access is via the foldable forms; any
// other read path (getVar / param / arrayLen / whole-string "$gv" / bare
// sh2.env / a shadowing param / a stale native read elsewhere)
// disqualifies it and leaves it on the store.

// ── foldArrayReads: collapse the nativeArrays output shape ──
// nativeArrays rewrites `sh2.arrayIndex("map", k)` to
// `(map || [])[Number(k)] ?? ""`. Once `map` is a module-level `let`
// binding (always an array), the `|| []` guard and the `Number()` are
// dead — `(map || [])` is always `map`, and `map[k]` treats a numeric
// key identically (property keys are strings anyway). Rewrite to
// `map[k] ?? ""`.
export function foldArrayReads(program) {
  if (!program || program.type !== "Program" || !Array.isArray(program.body)) return program;
  // the arrays folded by nativeArrays are module-level `let a = [...]`
  const moduleArrays = new Set();
  for (const st of program.body) {
    if (st && st.type === "VariableDeclaration" && st.kind === "let" && st.declarations) {
      for (const d of st.declarations) {
        if (d.id && d.id.type === "Identifier" && d.init && d.init.type === "ArrayExpression") moduleArrays.add(d.id.name);
      }
    }
  }
  if (!moduleArrays.size) return program;
  const id = (nm) => ({ type: "Identifier", name: nm });
  const rewrite = (n) => {
    if (!n || typeof n !== "object") return n;
    if (Array.isArray(n)) return n.map(rewrite);
    // `(arr || [])[Number(k)] ?? ""`
    if (n.type === "LogicalExpression" && n.operator === "??" && n.right &&
        n.right.type === "Literal" && n.right.value === "" &&
        n.left && n.left.type === "MemberExpression" && n.left.computed) {
      const mem = n.left;
      if (mem.object && mem.object.type === "LogicalExpression" && mem.object.operator === "||" &&
          mem.object.left && mem.object.left.type === "Identifier" && moduleArrays.has(mem.object.left.name) &&
          mem.object.right && mem.object.right.type === "ArrayExpression") {
        const K = mem.property;
        if (K && K.type === "CallExpression" && K.callee && K.callee.type === "Identifier" && K.callee.name === "Number" && K.arguments && K.arguments.length === 1) {
          return {
            type: "LogicalExpression", operator: "??",
            left: { type: "MemberExpression", computed: true, optional: false, object: id(mem.object.left.name), property: rewrite(K.arguments[0]) },
            right: n.right,
          };
        }
      }
    }
    const out = {};
    for (const k of Object.keys(n)) if (k !== "loc") out[k] = rewrite(n[k]);
    return out;
  };
  program.body = program.body.map(rewrite);
  return program;
}

export function nativeSharedScalars(program) {
  if (!program || program.type !== "Program" || !Array.isArray(program.body)) return program;
  // every `let <name>` anywhere (module, function body, loop head) — a
  // candidate with an EXISTING native binding would be shadowed by it
  // (function-local lets) or double-declared (module lets), so those
  // symbols stay on the store; the fold ADDS a module binding for the
  // store-only ones (like nativeArrays does for arrays).
  const declaredLets = new Set();
  const collectLets = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) collectLets(x); return; }
    if (n.type === "VariableDeclaration" && (n.kind === "let" || n.kind === "var")) {
      for (const d of n.declarations || []) if (d && d.id && d.id.type === "Identifier") declaredLets.add(d.id.name);
    }
    for (const k of Object.keys(n)) if (k !== "loc") collectLets(n[k]);
  };
  collectLets(program);
  // the whole `sh2.vars.X ?? (sh2.env.X ?? "")` read pattern
  const readPatternName = (n) => {
    if (!n || (n.type !== "LogicalExpression" && n.type !== "BinaryExpression") || n.operator !== "??") return null;
    const l = n.left;
    if (!l || l.type !== "MemberExpression" || l.computed || !l.property || l.property.type !== "Identifier" ||
        !l.object || l.object.type !== "MemberExpression" || l.object.computed ||
        !l.object.object || l.object.object.type !== "Identifier" || l.object.object.name !== "sh2" ||
        !l.object.property || l.object.property.type !== "Identifier" || l.object.property.name !== "vars") return null;
    const nm = l.property.name;
    const r = n.right;
    if (!r || (r.type !== "LogicalExpression" && r.type !== "BinaryExpression") || r.operator !== "??" ||
        !r.left || r.left.type !== "MemberExpression" || r.left.computed ||
        !r.left.property || r.left.property.type !== "Identifier" || r.left.property.name !== nm ||
        !r.left.object || r.left.object.type !== "MemberExpression" || r.left.object.computed ||
        !r.left.object.object || r.left.object.object.type !== "Identifier" || r.left.object.object.name !== "sh2" ||
        !r.left.object.property || r.left.object.property.type !== "Identifier" || r.left.object.property.name !== "env" ||
        !r.right || r.right.type !== "Literal" || r.right.value !== "") return null;
    return nm;
  };
  const recs = new Map();
  const get = (nm) => { if (!recs.has(nm)) recs.set(nm, { writes: [], reads: [], bad: new Set() }); return recs.get(nm); };
  const nameOf = (a) => (a && a.type === "Literal" && typeof a.value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a.value) ? a.value : null);
  const memTarget = (a) => {
    if (a && a.type === "Literal" && typeof a.value === "string") {
      const mm = /^\u0001mem:([A-Za-z_][A-Za-z0-9_]*):/.exec(a.value);
      if (mm && recs.has(mm[1])) get(mm[1]).bad.add("memHandle");
    }
  };
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    // consume the full `sh2.vars.X ?? (sh2.env.X ?? "")` read
    const rp = readPatternName(n);
    if (rp !== null) { get(rp).reads.push(n); return; }
    if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
        n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2") {
      const fn = n.callee.property && n.callee.property.type === "Identifier" ? n.callee.property.name : "";
      const a0 = n.arguments && n.arguments[0];
      if (fn === "setVar") {
        memTarget(a0);
        const nm = nameOf(a0);
        if (nm) get(nm).writes.push(n);
        for (const a of (n.arguments || []).slice(1)) walk(a);
        return;
      }
      if (fn === "getVar") { const nm = nameOf(a0); if (nm) get(nm).bad.add("getVar"); }
      if (fn === "arrayLen") { const nm = nameOf(a0); if (nm) get(nm).bad.add("arrayLen"); }
      if (fn === "param") {
        for (const a of n.arguments) { const nm = nameOf(a); if (nm) get(nm).bad.add("param"); }
        return;
      }
    }
    // a bare sh2.vars.X read (no env fallback) — the Proxy read is
    // foldable only when env is never consulted for X, so mark bad and
    // leave it on the store (the 73 bare uses in the game disqualify
    // those symbols; the ??-pattern ones above still fold)
    if (n.type === "MemberExpression" && !n.computed && n.property && n.property.type === "Identifier" &&
        n.object && n.object.type === "MemberExpression" && !n.object.computed &&
        n.object.object && n.object.object.type === "Identifier" && n.object.object.name === "sh2" &&
        n.object.property && n.object.property.type === "Identifier" && n.object.property.name === "vars") {
      get(n.property.name).bad.add("varsBare");
      return;
    }
    if (n.type === "MemberExpression" && !n.computed && n.property && n.property.type === "Identifier" &&
        n.object && n.object.type === "MemberExpression" && !n.object.computed &&
        n.object.object && n.object.object.type === "Identifier" && n.object.object.name === "sh2" &&
        n.object.property && n.object.property.type === "Identifier" && n.object.property.name === "env") {
      const nm = n.property.name;
      if (recs.has(nm)) get(nm).bad.add("envBare");
      return;
    }
    if (n.type === "Literal" && typeof n.value === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*[@*]?$/.test(n.value)) {
      const nm = n.value.slice(1).replace(/[@*]$/, "");
      if (recs.has(nm)) get(nm).bad.add("wholeStr");
      return;
    }
    for (const k of Object.keys(n)) if (k !== "loc") walk(n[k]);
  };
  walk(program);

  // a scalar whose name is ANY function's param would be shadowed by the
  // native binding — disqualify
  const paramNames = new Set();
  const collectParams = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) collectParams(x); return; }
    if (n.type === "FunctionDeclaration" && n.params) for (const p of n.params) if (p && p.type === "Identifier") paramNames.add(p.name);
    if (n.type === "ArrowFunctionExpression" && n.params) for (const p of n.params) if (p && p.type === "Identifier") paramNames.add(p.name);
    for (const k of Object.keys(n)) if (k !== "loc") collectParams(n[k]);
  };
  collectParams(program);

  const eligible = [];
  for (const [nm, r] of recs) {
    if (declaredLets.has(nm)) continue;
    if (paramNames.has(nm)) continue;
    if (!r.writes.length) continue;
    if (r.bad.size) continue;
    eligible.push(nm);
  }
  if (!eligible.length) return program;
  const elig = new Set(eligible);

  const id = (nm) => ({ type: "Identifier", name: nm });
  const str = (x) => ({ type: "CallExpression", callee: { type: "Identifier", name: "String" }, arguments: [x], optional: false });
  const rewrite = (n) => {
    if (!n || typeof n !== "object") return n;
    if (Array.isArray(n)) return n.map(rewrite);
    // `sh2.vars.X ?? (sh2.env.X ?? "")` → X
    const rp = readPatternName(n);
    if (rp !== null && elig.has(rp)) return id(rp);
    if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
        n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
        n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === "setVar") {
      const a0 = n.arguments && n.arguments[0];
      if (a0 && a0.type === "Literal" && typeof a0.value === "string" && elig.has(a0.value)) {
        const V = rewrite(n.arguments[1]);
        return { type: "AssignmentExpression", operator: "=", left: id(a0.value), right: str(V) };
      }
    }
    const out = {};
    for (const k of Object.keys(n)) if (k !== "loc") out[k] = rewrite(n[k]);
    return out;
  };
  program.body = program.body.map(rewrite);
  // give the folded scalars the native binding the reads/writes now use
  // (the store's initial value for an unset var is "")
  eligible.sort();
  program.body.unshift({
    type: "VariableDeclaration", kind: "let", declarations: eligible.map((nm) => ({
      type: "VariableDeclarator", id: id(nm), init: { type: "Literal", value: "", raw: null },
    })),
  });
  return program;
}

export function lowerI32Trunc(program) {
  if (!program || program.type !== "Program" || !Array.isArray(program.body)) return program;
  // interval fold: {lo, hi} integer bounds, or null when unprovable
  const bound = (n) => {
    if (!n || typeof n !== "object") return null;
    if (n.type === "Literal" && typeof n.value === "number" && Number.isFinite(n.value)) {
      return { lo: Math.floor(n.value), hi: Math.ceil(n.value) };
    }
    if (n.type === "UnaryExpression" && n.operator === "-" && n.argument) {
      const b = bound(n.argument);
      return b ? { lo: -b.hi, hi: -b.lo } : null;
    }
    if (n.type === "BinaryExpression") {
      const l = bound(n.left), r = bound(n.right);
      if (!l || !r) return null;
      switch (n.operator) {
        case "+": return { lo: l.lo + r.lo, hi: l.hi + r.hi };
        case "-": return { lo: l.lo - r.hi, hi: l.hi - r.lo };
        case "*": {
          const v = [l.lo * r.lo, l.lo * r.hi, l.hi * r.lo, l.hi * r.hi];
          return { lo: Math.min(...v), hi: Math.max(...v) };
        }
        case "/": {
          // integer division (Math.trunc semantics); a divisor crossing
          // zero is unprovable
          if (r.lo <= 0 && r.hi >= 0) return null;
          const v = [Math.trunc(l.lo / r.lo), Math.trunc(l.hi / r.lo), Math.trunc(l.lo / r.hi), Math.trunc(l.hi / r.hi)];
          return { lo: Math.min(...v), hi: Math.max(...v) };
        }
        default: return null; // % | & ^ << >> — leave alone
      }
    }
    return null; // var reads / calls / coercions — unprovable
  };
  const isTruncCall = (n) =>
    n && n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
    n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "Math" &&
    n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === "trunc" &&
    n.arguments && n.arguments.length === 1;
  const rewrite = (n) => {
    if (!n || typeof n !== "object") return n;
    if (Array.isArray(n)) return n.map(rewrite);
    if (isTruncCall(n)) {
      const X = n.arguments[0];
      const b = bound(X);
      if (b && b.lo >= -2147483648 && b.hi <= 2147483647) {
        return {
          type: "BinaryExpression", operator: "|",
          left: X, right: { type: "Literal", value: 0 },
        };
      }
    }
    const out = {};
    for (const k of Object.keys(n)) if (k !== "loc") out[k] = rewrite(n[k]);
    return out;
  };
  program.body = program.body.map(rewrite);
  return program;
}

function lowerPureRound(program) {
  if (!program || program.type !== "Program") return 0;
  const body = program.body || [];

  // 1. locate `sh2.define("name", arrow)` registrations
  const defs = []; // { stmt, name, arrow, idx }
  for (let i = 0; i < body.length; i++) {
    const st = body[i];
    if (!st || st.type !== "ExpressionStatement" || !st.expression) continue;
    const e = st.expression;
    if (e.type !== "CallExpression" || !e.callee || e.callee.type !== "MemberExpression" ||
        !e.callee.object || e.callee.object.type !== "Identifier" || e.callee.object.name !== "sh2" ||
        !e.callee.property || e.callee.property.type !== "Identifier" || e.callee.property.name !== "define" ||
        !e.arguments || e.arguments.length !== 2 || e.arguments[0].type !== "Literal" ||
        e.arguments[1].type !== "ArrowFunctionExpression") continue;
    defs.push({ stmt: st, name: String(e.arguments[0].value), arrow: e.arguments[1], idx: i });
  }
  if (!defs.length) return 0;

  const isCall = (n, obj, fn) =>
    n && n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
    n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === obj &&
    n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === fn;
  const litStr = (n) => (n && n.type === "Literal" && typeof n.value === "string" ? n.value : null);

  // 2. pure candidates: await-free body + positional-param prefix
  const lowered = new Set(); // fn names we convert
  const plan = [];          // { name, params, locals, syncs, body }
  for (const d of defs) {
    const block = d.arrow.body;
    if (!block || block.type !== "BlockStatement" || !Array.isArray(block.body)) continue;
    // lowerable if every await is a DEVICE call (`fs.write/read/…`) or an
    // exec of an ALREADY-lowered function (rewritten to a direct call).
    // Anything else (a builtin exec, capture, redirect, …) keeps the shell.
    let isAsync = false;
    let lowerable = true;
    const scanAwaits = (n) => {
      if (!lowerable || !n || typeof n !== "object") return;
      if (Array.isArray(n)) { for (const x of n) scanAwaits(x); return; }
      if (n.type === "AwaitExpression") {
        const a = n.argument;
        if (a && a.type === "CallExpression" && a.callee && a.callee.type === "MemberExpression" &&
            a.callee.object && a.callee.object.type === "Identifier" && a.callee.object.name === "fs") {
          isAsync = true; // device op — stays async, but callable directly
        } else {
          // exec/fnCall/callDirect of an ALREADY-lowered fn — the call
          // site becomes a direct call; the A1 emits fnCall/callDirect
          // for most user-function calls (the texture generators' pure
          // chain is fnCall all the way down), so match all three forms
          const info = shellFnCallInfo(a);
          if (info && lowered.has(info.name)) {
            // lowered callee — becomes a direct call
          } else {
            lowerable = false;
          }
        }
        return;
      }
      for (const k of Object.keys(n)) {
        if (k === "loc" || k === "parent") continue;
        scanAwaits(n[k]);
      }
    };
    scanAwaits(block);
    if (!lowerable) continue;
    // a body-level `return N` sets $? via the exec contract — the direct
    // call must propagate it (see the wrapReturn below)
    let hasReturn = false;
    const scanRet = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { for (const x of n) scanRet(x); return; }
      if (n.type === "ReturnStatement") hasReturn = true;
      for (const k of Object.keys(n)) if (k !== "loc") scanRet(n[k]);
    };
    scanRet(block);
    // leading positional copies: sh2.setVar("V", sh2.getVar("N"))
    const params = [];
    let i = 0;
    while (i < block.body.length) {
      const st = block.body[i];
      if (!st || st.type !== "ExpressionStatement" || !st.expression) break;
      const e = st.expression;
      if (!isCall(e, "sh2", "setVar") || !e.arguments || e.arguments.length !== 2) break;
      const nm = litStr(e.arguments[0]);
      if (!nm || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) break;
      const rhs = e.arguments[1];
      if (!isCall(rhs, "sh2", "getVar") || !rhs.arguments || rhs.arguments.length !== 1) break;
      const pos = litStr(rhs.arguments[0]);
      if (!pos || !/^[1-9]$/.test(pos)) break;
      if (params.some((p) => p.name === nm)) break;
      params.push({ name: nm, n: Number(pos) });
      i++;
    }
    // positions must be 1..n in order (drop the copies we consumed)
    params.sort((a, b) => a.n - b.n);
    let contiguous = true;
    params.forEach((p, k) => { if (p.n !== k + 1) contiguous = false; });
    if (!contiguous) continue;
    const paramSet = new Set(params.map((p) => p.name));
    const rest = block.body.slice(i);
    if (!rest.length) continue;
    // positional reads BEYOND the copied params (e.g. draw_rect uses
    // $5..$7 directly) — synthesize params so the direct call still
    // delivers them (scriptArgs is not set for direct calls)
    const maxN = Math.max(...params.map((p) => p.n), 0);
    const scanPos = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) scanPos(x); return; }
      if (isCall(node, "sh2", "getVar") && node.arguments && node.arguments[0] &&
          node.arguments[0].type === "Literal" && /^[1-9]$/.test(String(node.arguments[0].value))) {
        const n = Number(node.arguments[0].value);
        if (n > maxN && !params.some((pp) => pp.n === n)) params.push({ name: `_p${n}`, n, synthetic: true });
      }
      for (const k of Object.keys(node)) if (k !== "loc") scanPos(node[k]);
    };
    scanPos(rest);
    params.sort((a, b) => a.n - b.n);
    for (const pp of params) paramSet.add(pp.name);

    // store vars the body touches: getVar/setVar exact names + $name tokens
    const touched = new Set();
    const written = new Set();
    const scanBody = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) scanBody(x); return; }
      if (isCall(node, "sh2", "getVar") || isCall(node, "sh2", "setVar")) {
        const s = litStr(node.arguments && node.arguments[0]);
        if (s && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) touched.add(s);
        if (isCall(node, "sh2", "setVar") && s && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) written.add(s);
      }
      if (node.type === "Literal" && typeof node.value === "string") {
        for (const m of String(node.value).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) touched.add(m[1]);
      }
      if (node.type === "TemplateLiteral") {
        for (const q of node.quasis || []) {
          const t = q.value && (q.value.cooked != null ? q.value.cooked : q.value.raw);
          if (t == null) continue;
          for (const m of String(t).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) touched.add(m[1]);
        }
      }
      for (const k of Object.keys(node)) {
        if (k === "loc" || k === "parent") continue;
        scanBody(node[k]);
      }
    };
    scanBody(rest);
    // drop the param names (their body refs become the params)
    for (const p of params) { touched.delete(p.name); written.delete(p.name); }
    // the outside-refs scan must also see the PARAMS — the original
    // param copies wrote the store, and other functions may read them
    // back after the call (start_anim's ax0..ay1 are read by render_frame)
    const allVars = new Set(touched);
    for (const pp of params) allVars.add(pp.name);

    // which touched vars are referenced OUTSIDE this function's body?
    const refsOutside = new Map(); // name → true
    const scanProg = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) scanProg(x); return; }
      if (node === d.arrow) return; // skip the function's own body entirely
      if (isCall(node, "sh2", "getVar") || isCall(node, "sh2", "setVar")) {
        const s = litStr(node.arguments && node.arguments[0]);
        if (s && allVars.has(s)) refsOutside.set(s, true);
      }
      if (node.type === "Literal" && typeof node.value === "string") {
        for (const m of String(node.value).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
          if (allVars.has(m[1])) refsOutside.set(m[1], true);
        }
      }
      if (node.type === "TemplateLiteral") {
        for (const q of node.quasis || []) {
          const t = q.value && (q.value.cooked != null ? q.value.cooked : q.value.raw);
          if (t == null) continue;
          for (const m of String(t).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
            if (allVars.has(m[1])) refsOutside.set(m[1], true);
          }
        }
      }
      for (const k of Object.keys(node)) {
        if (k === "loc" || k === "parent") continue;
        scanProg(node[k]);
      }
    };
    scanProg(program);
    // vars written by OTHER functions can't be promoted: the callee's
    // store sync is the only channel a result var (fmt3's `fv`) uses, so
    // a promoted local would go stale between calls. Promote only vars
    // written HERE and nowhere else.
    const elsewhere = new Set();
    const scanWriters = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const x of node) scanWriters(x); return; }
      if (node === d.arrow) return; // the function's own body is excluded — everything else is elsewhere
      if (isCall(node, "sh2", "setVar") && node.arguments && node.arguments[0] &&
          node.arguments[0].type === "Literal" && typeof node.arguments[0].value === "string" &&
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.arguments[0].value)) {
        elsewhere.add(node.arguments[0].value);
      }
      for (const k of Object.keys(node)) {
        if (k === "loc" || k === "parent") continue;
        scanWriters(node[k]);
      }
    };
    scanWriters(program);
    const promotable = new Set([...written].filter((v) => !elsewhere.has(v)));
    // a var WRITTEN inside and read outside → sync at the end; a param
    // read outside too (the store protocol needs the final value back)
    const syncs = [...touched].filter((v) => written.has(v) && refsOutside.has(v) && !elsewhere.has(v));
    for (const pp of params) if (refsOutside.has(pp.name)) syncs.push(pp.name);

    lowered.add(d.name);
    plan.push({ def: d, name: d.name, params, paramSet, touched, written, promotable, syncs, rest, hasReturn, isAsync });
  }
  if (!plan.length) return 0;

  // 3. transitive async: a function calling an ASYNC lowered callee must
  //    be async itself (its direct call will be `await g(...)`). The base
  //    isAsync covers the device awaits; propagate through the exec calls.
  const planByName = new Map(plan.map((p) => [p.name, p]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of plan) {
      if (p.isAsync) continue;
      let callsAsync = false;
      walk(p.rest, (n) => {
        if (callsAsync) return;
        const info = shellFnCallInfo(n);
        if (info) {
          const g = planByName.get(info.name);
          if (g && g.isAsync) callsAsync = true;
        }
      });
      if (callsAsync) { p.isAsync = true; changed = true; }
    }
  }

  // 4. rewrite body + build the native function + adapter
  const rewriteBody = makeBodyRewriter();
  const newBody = [];
  for (const st of body) {
    const p = plan.find((x) => x.def.stmt === st);
    if (!p) { newBody.push(st); continue; }
    const stmts = rewriteBody(p.rest, p);
    // the store handoff must run on EVERY exit path — insert the syncs
    // before each `return` (a trailing `return N` would dead-code
    // end-of-body syncs); with no returns, append at the end
    if (p.syncs.length) {
      const syncStmts = p.syncs.map((v) => isCallStmt("setVar", v));
      let placed = 0;
      const place = (list) => {
        if (!Array.isArray(list)) return;
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          if (!s || !s.type) continue;
          if (s.type === "ReturnStatement") {
            list.splice(i, 0, ...syncStmts);
            placed += syncStmts.length;
            i += syncStmts.length;
          } else if (s.type === "IfStatement") {
            if (s.consequent) place(s.consequent.type === "BlockStatement" ? s.consequent.body : [s.consequent]);
            if (s.alternate) place(s.alternate.type === "BlockStatement" ? s.alternate.body : [s.alternate]);
          } else if (s.type === "BlockStatement") {
            place(s.body);
          }
        }
      };
      place(stmts);
      if (!placed) stmts.push(...syncStmts);
    }
    const locals = [...p.promotable].sort(); // only promotable vars go native
    const fnDecl = {
      type: "FunctionDeclaration",
      id: { type: "Identifier", name: p.name },
      params: p.params.map((pp) => ({ type: "Identifier", name: pp.name })),
      body: {
        type: "BlockStatement",
        body: [
          ...(locals.length ? [{ type: "VariableDeclaration", kind: "let", declarations: locals.map((v) => ({
            type: "VariableDeclarator", id: { type: "Identifier", name: v },
            init: { type: "CallExpression", callee: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: "getVar" } }, arguments: [{ type: "Literal", value: v, raw: null }], optional: false },
          })) }] : []),
          ...stmts,
        ],
      },
      generator: false,
      expression: false,
      async: p.isAsync,
    };
    const adapter = {
      type: "ArrowFunctionExpression",
      params: [],
      body: {
        type: "CallExpression",
        callee: { type: "Identifier", name: p.name },
        arguments: p.params.map((pp) => ({
          type: "CallExpression", callee: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: "getVar" } },
          arguments: [{ type: "Literal", value: String(pp.n), raw: null }], optional: false,
        })),
        optional: false,
      },
      expression: true,
      async: false,
    };
    const define = {
      type: "ExpressionStatement",
      expression: {
        type: "CallExpression",
        callee: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: "define" } },
        arguments: [{ type: "Literal", value: p.name, raw: null }, adapter],
        optional: false,
      },
    };
    newBody.push(fnDecl, Object.assign(define, { _sh2Adapter: true }));
  }
  program.body = newBody;

  // 4. rewrite call sites: await sh2.exec/fnCall/callDirect("f", …)
  //    → f(args) — and the BARE (non-awaited) sync forms too
  const directCallStmt = (info) => {
    const fname = info.name;
    const callExpr = {
      type: "CallExpression",
      callee: { type: "Identifier", name: fname },
      arguments: info.args.map((a) => rewriteCalls(a)),
      optional: false,
    };
    // a function with a body-level `return N` sets $? through the exec
    // contract — the direct call must propagate the value the same way
    const p = plan.find((x) => x.name === fname);
    const asyncFn = !!(p && p.isAsync);
    if (p && p.hasReturn) {
      const ret = { type: "Identifier", name: "__ret" };
      const typeofCmp = (t) => ({
        type: "BinaryExpression", operator: "===",
        left: { type: "UnaryExpression", operator: "typeof", prefix: true, argument: ret },
        right: { type: "Literal", value: t, raw: null },
      });
      const inner = asyncFn
        ? { type: "AwaitExpression", argument: callExpr }
        : callExpr;
      return {
        type: "ExpressionStatement",
        expression: {
          type: "CallExpression",
          callee: {
            type: "ArrowFunctionExpression", params: [],
            body: {
              type: "BlockStatement",
              body: [
                // the emitter lowers a function-body `return N` to
                // `throw sh2.ReturnSignal(N)` — the exec/fnCall dispatch
                // unwraps it, but a BARE direct call would leak the
                // signal into the caller and abort it. Catch it here
                // and unwrap the value like the dispatch does.
                { type: "VariableDeclaration", kind: "let", declarations: [{ type: "VariableDeclarator", id: { type: "Identifier", name: "__ret" }, init: null }] },
                {
                  type: "TryStatement",
                  block: {
                    type: "BlockStatement",
                    body: [{
                      type: "ExpressionStatement",
                      expression: {
                        type: "AssignmentExpression", operator: "=",
                        left: { type: "Identifier", name: "__ret" },
                        right: inner,
                      },
                    }],
                  },
                  handler: {
                    type: "CatchClause",
                    param: { type: "Identifier", name: "__e" },
                    body: {
                      type: "BlockStatement",
                      body: [{
                        type: "IfStatement",
                        test: {
                          type: "BinaryExpression", operator: "instanceof",
                          left: { type: "Identifier", name: "__e" },
                          right: {
                            type: "MemberExpression", computed: false, optional: false,
                            object: { type: "Identifier", name: "sh2" },
                            property: { type: "Identifier", name: "ReturnSignal" },
                          },
                        },
                        consequent: {
                          type: "ExpressionStatement",
                          expression: {
                            type: "AssignmentExpression", operator: "=",
                            left: { type: "Identifier", name: "__ret" },
                            right: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "__e" }, property: { type: "Identifier", name: "value" } },
                          },
                        },
                        alternate: {
                          type: "ThrowStatement",
                          argument: { type: "Identifier", name: "__e" },
                        },
                      }],
                    },
                  },
                  finalizer: null,
                },
                {
                  type: "IfStatement",
                  test: { type: "LogicalExpression", operator: "||", left: typeofCmp("string"), right: typeofCmp("number") },
                  consequent: {
                    type: "ExpressionStatement",
                    expression: {
                      type: "CallExpression",
                      callee: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: "setLastExit" } },
                      arguments: [{ type: "CallExpression", callee: { type: "Identifier", name: "Number" }, arguments: [ret], optional: false }],
                      optional: false,
                    },
                  },
                },
              ],
            },
            expression: false, async: asyncFn,
          },
          arguments: [], optional: false,
        },
      };
    }
    if (asyncFn) {
      return { type: "ExpressionStatement", expression: { type: "AwaitExpression", argument: callExpr } };
    }
    return { type: "ExpressionStatement", expression: callExpr };
  };
  const rewriteCalls = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(rewriteCalls);
    if (node.type === "ExpressionStatement" && node.expression) {
      // unwrap a top-level sh2.guard(...) wrapper
      let e = node.expression;
      if (isCall(e, "sh2", "guard") && e.arguments && e.arguments.length === 1) e = e.arguments[0];
      if (e && e.type === "AwaitExpression") {
        const inner = rewriteCalls(e);
        // the return-propagating wrapper is already a statement
        if (inner && inner.type === "ExpressionStatement") return inner;
        return { type: "ExpressionStatement", expression: inner };
      }
      // a BARE shell-fn call (the sync forms — callDirect/fnCall without
      // await) of a lowered fn → direct call
      const info = shellFnCallInfo(e);
      if (info && lowered.has(info.name)) return directCallStmt(info);
      const out = { type: "ExpressionStatement", expression: rewriteCalls(node.expression) };
      return out;
    }
    if (node.type === "AwaitExpression" && node.argument && node.argument.type === "CallExpression") {
      const info = shellFnCallInfo(node.argument);
      if (info && lowered.has(info.name)) return directCallStmt(info);
    }
    const out = {};
    for (const k of Object.keys(node)) out[k] = rewriteCalls(node[k]);
    return out;
  };
  program.body = program.body.map(rewriteCalls);
  return plan.length;
}

const isCallStmt = (fn, name) => ({
  type: "ExpressionStatement",
  expression: {
    type: "CallExpression",
    callee: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: fn } },
    arguments: [{ type: "Literal", value: name, raw: null }, { type: "Identifier", name }],
    optional: false,
  },
});

// the body store→native rewriter for the lowered function
function makeBodyRewriter() {
  const isCall = (n, obj, fn) =>
    n && n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
    n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === obj &&
    n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === fn;
  const litStr = (n) => (n && n.type === "Literal" && typeof n.value === "string" ? n.value : null);
  // promote only vars THIS function writes (or its params): a read-only
  // var like `gv` is written by a CALLEE's sync, so the store read must
  // stay (a stale local would miss the callee's output)
  const inSet = (p, v) => p.promotable.has(v) || p.paramSet.has(v);

  const splitVars = (text, p) => {
    const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g;
    const segs = []; let last = 0, m;
    while ((m = re.exec(text))) {
      const nm = m[1] || m[2];
      if (!inSet(p, nm)) continue;
      if (m.index > last) segs.push({ text: text.slice(last, m.index) });
      segs.push({ text: "", expr: nm });
      last = m.index + m[0].length;
    }
    if (last < text.length) segs.push({ text: text.slice(last) });
    return segs;
  };
  const toTemplate = (segs) => {
    const quasis = [], expressions = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.expr) expressions.push({ type: "Identifier", name: seg.expr });
      else quasis.push({ type: "TemplateElement", value: { raw: toRaw(seg.text), cooked: seg.text }, tail: false });
    }
    if (quasis.length) quasis[quasis.length - 1].tail = true;
    if (expressions.length >= quasis.length) {
      quasis.unshift({ type: "TemplateElement", value: { raw: "", cooked: "" }, tail: false });
    }
    if (expressions.length >= quasis.length) {
      quasis.push({ type: "TemplateElement", value: { raw: "", cooked: "" }, tail: true });
    }
    if (quasis.length) quasis[quasis.length - 1].tail = true;
    return { type: "TemplateLiteral", quasis, expressions };
  };

  const expr = (node, p) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((n) => expr(n, p));
    // NOTE: the `(Number(sh2.getVar("V")) || 0)` guard is DELIBERATELY
    // kept — a promoted var can hold a STRING (`vn_n00 = sh2.getVar("lhn")`
    // reads the store, a string), so `V + 1` would concatenate instead of
    // adding. Only the store round-trip is removed, never the coercion.
    if (isCall(node, "sh2", "getVar") && node.arguments && node.arguments[0]) {
      const nm = litStr(node.arguments[0]);
      if (nm && inSet(p, nm)) return { type: "Identifier", name: nm };
      // a positional read beyond the copied params (draw_rect's $5..$7) —
      // the synthesized param delivers it under a direct call
      if (nm && /^[1-9]$/.test(nm)) {
        const prm = p.params.find((pp) => pp.n === Number(nm));
        if (prm) return { type: "Identifier", name: prm.name };
      }
    }
    // sh2.param("", "V") — a plain store read of a promoted var → the local
    if (isCall(node, "sh2", "param") && node.arguments && node.arguments.length >= 2 &&
        node.arguments[0] && node.arguments[0].type === "Literal" && node.arguments[0].value === "" &&
        node.arguments[1] && node.arguments[1].type === "Literal" &&
        typeof node.arguments[1].value === "string" && inSet(p, node.arguments[1].value)) {
      return { type: "Identifier", name: node.arguments[1].value };
    }
    // sh2.param("slice", "V", …) — a substring read of a promoted var
    // (${V:off:len}): the var arrives as a NATIVE parameter/local, so the
    // store round-trip would slice the unset store copy (empty) — every
    // lowered draw_text char came back "" and glyph_index returned the
    // blank space glyph, making all canvas text invisible. Rewrite to
    // V.slice(off, off+len) with the native binding.
    if (isCall(node, "sh2", "param") && node.arguments && node.arguments.length >= 3 &&
        node.arguments[0] && node.arguments[0].type === "Literal" && node.arguments[0].value === "slice" &&
        node.arguments[1] && node.arguments[1].type === "Literal" &&
        typeof node.arguments[1].value === "string" && inSet(p, node.arguments[1].value)) {
      const nm = node.arguments[1].value;
      const off = expr(node.arguments[2], p);
      const len = node.arguments.length > 3 ? expr(node.arguments[3], p) : null;
      // the runtime's param("slice") semantics are slice(start, start+len)
      // (the end index, exclusive) — mirror that exactly
      const args = [off];
      if (len) args.push({ type: "BinaryExpression", operator: "+", left: off,
        right: { type: "UnaryExpression", operator: "+", prefix: true, argument: len } });
      return {
        type: "CallExpression",
        callee: { type: "MemberExpression", object: { type: "Identifier", name: nm },
                 property: { type: "Identifier", name: "slice" }, computed: false },
        arguments: args,
      };
    }
    if (isCall(node, "sh2", "setVar") && node.arguments && node.arguments.length === 2 && node.arguments[0]) {
      const nm = litStr(node.arguments[0]);
      if (nm && inSet(p, nm)) {
        // sh2.setVar("V", sh2.arithEval(() => EXPR)) → V = EXPR
        const rhs = node.arguments[1];
        if (isCall(rhs, "sh2", "arithEval") && rhs.arguments && rhs.arguments[0]) {
          const arrow = rhs.arguments[0];
          let body2 = arrow && arrow.type === "ArrowFunctionExpression" ? (arrow.expression ? arrow.body :
            (arrow.body && arrow.body.type === "BlockStatement" && arrow.body.body.length === 1 && arrow.body.body[0].type === "ReturnStatement" ? arrow.body.body[0].argument : null)) : null;
          if (body2) {
            return { type: "AssignmentExpression", operator: "=", left: { type: "Identifier", name: nm }, right: expr(body2, p) };
          }
        }
        return { type: "AssignmentExpression", operator: "=", left: { type: "Identifier", name: nm }, right: expr(rhs, p) };
      }
    }
    if (node.type === "Literal" && typeof node.value === "string") {
      const segs = splitVars(String(node.value), p);
      // a lone `$V` token (e.g. arrayIndex's "$gi" arg) is still an
      // interpolation — the template is just `\`${V}\``
      if (segs.length > 1 || (segs.length === 1 && segs[0].expr)) return toTemplate(segs);
      return node;
    }
    if (node.type === "TemplateLiteral") {
      let any = false;
      for (const q of node.quasis || []) {
        const t = q.value && (q.value.cooked != null ? q.value.cooked : q.value.raw);
        if (t == null) continue;
        const segs = splitVars(String(t), p);
        if (segs.length > 1 || (segs.length === 1 && segs[0].expr)) any = true;
      }
      if (any) {
        const outQ = [], outE = [];
        for (let i = 0; i < node.quasis.length; i++) {
          const q = node.quasis[i];
          const t = (q.value && q.value.cooked != null ? q.value.cooked : q.value.raw) || "";
          for (const seg of splitVars(String(t), p)) {
            // expr segments carry no text — the `$V` token becomes the
            // expression alone; only text segments become quasis
            if (seg.expr) outE.push({ type: "Identifier", name: seg.expr });
            else outQ.push({ type: "TemplateElement", value: { raw: toRaw(seg.text), cooked: seg.text }, tail: false });
          }
          if (i < node.expressions.length) outE.push(expr(node.expressions[i], p));
        }
        if (outE.length >= outQ.length) outQ.unshift({ type: "TemplateElement", value: { raw: "", cooked: "" }, tail: false });
        if (outE.length >= outQ.length) outQ.push({ type: "TemplateElement", value: { raw: "", cooked: "" }, tail: true });
        if (outQ.length) outQ[outQ.length - 1].tail = true;
        return { type: "TemplateLiteral", quasis: outQ, expressions: outE };
      }
      const out = { ...node };
      out.expressions = (node.expressions || []).map((x) => expr(x, p));
      return out;
    }
    const out = {};
    for (const k of Object.keys(node)) out[k] = expr(node[k], p);
    return out;
  };

  return (stmts, p) => stmts.map((s) => {
    if (s && s.type === "ExpressionStatement" && s.expression) {
      const e = s.expression;
      if (isCall(e, "sh2", "setVar") && e.arguments && e.arguments.length === 2 && e.arguments[0]) {
        const nm = litStr(e.arguments[0]);
        if (nm && inSet(p, nm)) {
          return { type: "ExpressionStatement", expression: expr(e, p) };
        }
      }
    }
    return expr(s, p);
  });
}

// ── nativeForLoops: recover native `for` from counter while-loops ──
//
// Every bash `while` lowers to `await sh2.whileLoop(async () => COND,
// async () => { … })`. When the loop is a plain counter loop —
//
//   V = INIT;
//   await sh2.whileLoop(async () => COND(V), async () => { …; V = V + K; });
//
// — the runtime indirection is dead weight: the condition and counter
// are already NATIVE bindings (the emitter hoisted the arithmetic out
// of the store), so each iteration pays two async-closure allocations,
// a promise round-trip and a maybeYield check for a loop a native `for`
// runs in one stack frame. This pass recovers the `for` (mimecroft's
// render_frame/gen_maze/minimap/draw_char loops — ~16 of them).
//
// Guards (conservative — the transform never changes observable order):
//   • the init must be a plain `V = INIT` immediately before the loop
//   • the loop's LAST body statement must be the counter update
//     (V = V + K / V = V - K / V += K / V -= K) — in both forms the
//     update runs exactly once, after the rest of the body
//   • no other statement in the body may write V (a for-update would
//     clobber an interleaved write; body-side writes must stay)
//   • no sh2.break()/sh2.continue() anywhere in the body (the bare
//     LoopSignal would ESCAPE the native for and hit the wrong handler;
//     sh2.return/ReturnSignal is fine — it propagates identically)
//   • the condition must be sync (no await) — the runtime cond closure
//     is not needed
//   • the body must contain an await (an all-sync native loop would
//     never hit maybeYield; loops that await exec/capture yield
//     naturally)
//
// V keeps its post-loop value in the outer scope (the for reuses the
// EXISTING binding — no `let` shadow), identical to the while form.

export function nativeForLoops(program) {
  const queue = [program.body];
  while (queue.length) {
    const stmts = queue.shift();
    for (let i = 0; i < stmts.length; i++) {
      let conv = null;
      if (i >= 1) {
        conv = tryConvert(stmts, i) || tryConvertStoreCounter(stmts, i, program) || tryConvertWhile(stmts, i);
      }
      if (conv) {
        // remove the init statement (if any — a let declaration is kept
        // when it declares other names), then replace the loop with the
        // for (+ store sync). Between statements stay in place; the for's
        // init clause runs V = INIT at the loop start, order-identical.
        if (conv.initIdx >= 0) stmts.splice(conv.initIdx, 1);
        const loopIdx = i - (conv.initIdx >= 0 && conv.initIdx < i ? 1 : 0);
        stmts.splice(loopIdx, 1, ...conv.stmts);
        walk(conv.stmts[0], (n) => {
          if ((n.type === "BlockStatement" || n.type === "Program") && Array.isArray(n.body)) queue.push(n.body);
        });
        i -= 1;
        continue;
      }
      // collect nested statement lists for later (each exactly once)
      walk(stmts[i], (n) => {
        if ((n.type === "BlockStatement" || n.type === "Program") && Array.isArray(n.body)) queue.push(n.body);
      });
    }
  }
  return program;
}

const isSh2WhileLoop = (n) =>
  n && n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
  n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
  n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === "whileLoop";

// The whileLoop statement: `[sh2.guard(] await sh2.whileLoop(condArrow,
// bodyArrow) [)]` (or the bare call — top-level statements carry a
// sh2.guard wrapper, loop-body statements don't). Returns { cond, body }
// or null. The cond may be an `await sh2.and/or(...)` chain of sync
// leaves — flattened to a native &&/|| here (short-circuit is identical).
function whileLoopParts(stmt) {
  if (!stmt || stmt.type !== "ExpressionStatement" || !stmt.expression) return null;
  let call = null;
  let e = stmt.expression;
  if (e.type === "CallExpression" && e.callee && e.callee.type === "MemberExpression" &&
      e.callee.object && e.callee.object.type === "Identifier" && e.callee.object.name === "sh2" &&
      e.callee.property && e.callee.property.type === "Identifier" && e.callee.property.name === "guard" &&
      e.arguments && e.arguments.length === 1) e = e.arguments[0];
  if (e.type === "AwaitExpression") call = e.argument;
  else call = e;
  if (!isSh2WhileLoop(call) || !call.arguments || call.arguments.length !== 2) return null;
  const [condArrow, bodyArrow] = call.arguments;
  if (!condArrow || condArrow.type !== "ArrowFunctionExpression" || !bodyArrow || bodyArrow.type !== "ArrowFunctionExpression") return null;
  let cond = null;
  if (condArrow.expression) cond = condArrow.body;
  else if (condArrow.body.type === "BlockStatement" && condArrow.body.body.length === 1 &&
           condArrow.body.body[0].type === "ReturnStatement") cond = condArrow.body.body[0].argument;
  if (!cond) return null;
  const flat = flattenAndOr(cond);
  if (flat) cond = flat;
  else if (hasAwait(cond)) return null;   // async condition — keep runtime loop
  const body = bodyArrow.body;
  if (!body || body.type !== "BlockStatement" || !Array.isArray(body.body) || body.body.length === 0) return null;
  return { cond, body: body.body };
}

// ── flattenAndOr: `await sh2.and(f1, f2)` / `await sh2.or(f1, f2)` with
//    SYNC leaf arrows → a native `&&` / `||` expression. The runtime and()
//    returns `!!(await a()) && !!(await b())` — for boolean leaves the
//    !! is a no-op and short-circuiting is identical, so the native form
//    is equivalent and drops per-check async closures.
function flattenAndOr(node) {
  if (!node || node.type !== "AwaitExpression") return null;
  const call = node.argument;
  if (!call || call.type !== "CallExpression" || !call.callee || call.callee.type !== "MemberExpression" ||
      !call.callee.object || call.callee.object.type !== "Identifier" || call.callee.object.name !== "sh2" ||
      !call.callee.property || call.callee.property.type !== "Identifier" ||
      (call.callee.property.name !== "and" && call.callee.property.name !== "or")) return null;
  const op = call.callee.property.name === "and" ? "&&" : "||";
  const leaves = [];
  for (const a of call.arguments || []) {
    if (!a || a.type !== "ArrowFunctionExpression") return null;
    let e = a.expression ? a.body :
      (a.body && a.body.type === "BlockStatement" && a.body.body.length === 1 &&
       a.body.body[0].type === "ReturnStatement" ? a.body.body[0].argument : null);
    if (!e) return null;
    if (e.type === "AwaitExpression") {
      const sub = flattenAndOr(e);
      if (!sub) return null;
      leaves.push(sub);
    } else {
      if (hasAwait(e)) return null;
      leaves.push(e);
    }
  }
  if (!leaves.length) return null;
  let out = leaves[0];
  for (let i = 1; i < leaves.length; i++) {
    out = { type: "LogicalExpression", operator: op, left: out, right: leaves[i] };
  }
  return out;
}

// `V = RHS` (init, any RHS — evaluated once before the first check in
// both forms, so it is order-identical) or the counter update
// `V = V + K / V = V - K / V += K / V -= K` (must reference V).
function counterExpr(stmt, name, { update }) {
  if (!stmt || stmt.type !== "ExpressionStatement" || !stmt.expression) return null;
  const e = stmt.expression;
  if (e.type !== "AssignmentExpression" || e.left.type !== "Identifier" || e.left.name !== name) return null;
  if (update) {
    if (e.operator === "+=" || e.operator === "-=") return e;
    if (e.operator === "=" && e.right.type === "BinaryExpression" &&
        (e.right.operator === "+" || e.right.operator === "-") &&
        e.right.left.type === "Identifier" && e.right.left.name === name) return e;
    return null;
  }
  return e;
}

// Does any node in `root` assign/declare `name`?
function writesName(root, name) {
  let found = false;
  walk(root, (n) => {
    if (found) return;
    if ((n.type === "AssignmentExpression" || n.type === "UpdateExpression") &&
        n.left && n.left.type === "Identifier" && n.left.name === name) found = true;
    if (n.type === "VariableDeclarator" && n.id && n.id.type === "Identifier" && n.id.name === name) found = true;
  });
  return found;
}

function hasLoopSignal(root) {
  let found = false;
  walk(root, (n) => {
    if (found || !n || n.type !== "CallExpression" || !n.callee || n.callee.type !== "MemberExpression") return;
    if (n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
        n.callee.property && n.callee.property.type === "Identifier" &&
        (n.callee.property.name === "break" || n.callee.property.name === "continue")) found = true;
  });
  return found;
}

// local hasAwait (lower.js is imported by estree.js — no circular import)
function hasAwait(node) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasAwait);
  if (node.type === "AwaitExpression") return true;
  for (const k of Object.keys(node)) if (k !== "loc" && hasAwait(node[k])) return true;
  return false;
}

// ── tryConvert: recover a native `for` for a NATIVE-counter while loop ──
//
//   V = INIT;                (or `let V = INIT, W = …` at top level —
//   …between stmts…             mergeInitAssignments folded the real value in;
//   await sh2.whileLoop(…);     between stmts must not touch V, and when
//                               they exist INIT must be a literal)
//
// The init may sit a few statements before the loop (e.g. `sm_tries = 0`
// after `sm_placed = 0`); those between statements stay where they are —
// the for's init clause runs V = INIT at the loop start, which is
// unobservable when they don't touch V and INIT is pure.
// Returns { stmts, initIdx } or null.
function tryConvert(stmts, i) {
  const loop = whileLoopParts(stmts[i]);
  if (!loop) return null;
  // scan back for candidate inits (assignments and let declarators)
  const candidates = []; // { name, init, idx, keepDecl }
  for (let k = i - 1; k >= 0 && k >= i - 10; k--) {
    const st = stmts[k];
    if (st.type === "ExpressionStatement" && st.expression &&
        st.expression.type === "AssignmentExpression" && st.expression.operator === "=" &&
        st.expression.left.type === "Identifier") {
      candidates.push({ name: st.expression.left.name, init: st.expression, idx: k, keepDecl: false });
      continue;
    }
    if (st.type === "VariableDeclaration" && st.kind === "let" && st.declarations) {
      for (const d of st.declarations) {
        if (d.id && d.id.type === "Identifier" && d.init) {
          candidates.push({
            name: d.id.name,
            init: { type: "AssignmentExpression", operator: "=", left: { type: "Identifier", name: d.id.name }, right: d.init },
            idx: k,
            keepDecl: true,
          });
        }
      }
      continue;
    }
    // a non-init statement: a candidate found further back is only valid
    // if statements between don't touch it — checked per candidate below.
  }
  const body = loop.body;
  for (const cand of candidates) {
    // statements between the init and the loop must not touch the counter
    let betweenTouches = false;
    for (let k = cand.idx + 1; k < i && !betweenTouches; k++) {
      if (touchesName(stmts[k], cand.name)) betweenTouches = true;
    }
    if (betweenTouches) continue;
    // non-adjacent init: moving its evaluation into the for-init must be
    // unobservable — require a literal RHS (no side effects to relocate)
    if (cand.idx !== i - 1) {
      const r = cand.init.right;
      if (!r || r.type !== "Literal") continue;
    }
    const lastStmt = body[body.length - 1];
    const update = counterExpr(lastStmt, cand.name, { update: true });
    if (!update) continue;
    // no other body statement (and no condition) may write the counter
    if (writesName({ type: "BlockStatement", body: body.slice(0, -1) }, cand.name)) continue;
    if (writesName(loop.cond, cand.name)) continue;
    // break/continue would escape a native for
    if (hasLoopSignal(body)) continue;
    // keep pure (await-free) loops on whileLoop — they need maybeYield
    if (!hasAwait(body)) continue;
    const forNode = {
      type: "ForStatement",
      init: cand.init,
      test: loop.cond,
      update: update,
      body: { type: "BlockStatement", body: body.slice(0, -1) },
    };
    // remove the init statement (the let declaration is kept — it may
    // declare other names), replace the loop with the for
    const out = [forNode];
    const initIdx = cand.keepDecl ? -1 : cand.idx;
    return { stmts: out, initIdx };
  }
  return null;
}

// ── tryConvertStoreCounter: recover a native `for` for a STORE-counter
//    while loop (the mime_at / can_step / update_mimes shape):
//
//   sh2.setVar("V", INIT);
//   await sh2.whileLoop(async () => sh2.test("…$V…"), async () => {
//     … sh2.getVar("V") / sh2.arrayIndex("a", "$V") / setVar("a[$V]", …) …
//     sh2.setVar("V", sh2.arithEval(() => (Number(sh2.getVar("V")) || 0) + 1));
//   });
//
// The counter is promoted to the EXISTING native binding (the for reuses
// it, so the post-loop value is identical to the while form) and every
// in-loop store reference is rewritten to the native binding: getVar →
// identifier, `"$V"` operands in test strings / arrayIndex / param / setVar
// names → `${V}` interpolations or direct identifiers. A store sync
// (`sh2.setVar("V", V)`) after the loop keeps the store truthful.
//
// Guards: the counter must have NO store references anywhere outside the
// loop pair (whole-program count check) and no native identifier reads
// outside it either; no other body statement may write the store counter;
// no break/continue; body must await.
// Returns { stmts, initIdx } or null.
function tryConvertStoreCounter(stmts, i, program) {
  const loop = whileLoopParts(stmts[i]);
  if (!loop) return null;
  // find the counter's `sh2.setVar("V", INIT)` init — adjacent, or a few
  // statements back when nothing between touches V and INIT is a literal
  let initStmt = null, initE = null;
  for (let k = i - 1; k >= 0 && k >= i - 10; k--) {
    const st = stmts[k];
    let e = st && st.type === "ExpressionStatement" && st.expression ? st.expression : null;
    if (e && e.type === "CallExpression" && e.callee && e.callee.type === "MemberExpression" &&
        e.callee.object && e.callee.object.type === "Identifier" && e.callee.object.name === "sh2" &&
        e.callee.property && e.callee.property.type === "Identifier" && e.callee.property.name === "guard" &&
        e.arguments && e.arguments.length === 1) e = e.arguments[0]; // top-level sh2.guard wrapper
    if (e && e.type === "CallExpression" && e.callee && e.callee.type === "MemberExpression" &&
        e.callee.object && e.callee.object.type === "Identifier" && e.callee.object.name === "sh2" &&
        e.callee.property && e.callee.property.type === "Identifier" && e.callee.property.name === "setVar" &&
        e.arguments && e.arguments[0] && e.arguments[0].type === "Literal" &&
        typeof e.arguments[0].value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.arguments[0].value)) {
      initStmt = st; initE = e;
      // statements between must not touch the counter; non-adjacent init
      // must be a literal (moving its evaluation is unobservable)
      let betweenTouches = false;
      for (let j = k + 1; j < i && !betweenTouches; j++) {
        if (touchesName(stmts[j], e.arguments[0].value)) betweenTouches = true;
      }
      if (betweenTouches) return null;
      if (k !== i - 1) {
        const v = e.arguments[1];
        if (!v || v.type !== "Literal") return null;
      }
      break;
    }
  }
  if (!initStmt || !initE) return null;
  const initIdx = stmts.indexOf(initStmt);
  if (initIdx < 0) return null;
  const name = initE.arguments[0].value;
  const body = loop.body;
  const lastStmt = body[body.length - 1];
  const update = storeIncrement(lastStmt, name);
  if (!update) return null;
  // no other body statement may write the store counter (setVar("V", …))
  if (writesStoreName({ type: "BlockStatement", body: body.slice(0, -1) }, name)) return null;
  if (writesStoreName(loop.cond, name)) return null;
  if (hasLoopSignal(body)) return null;
  if (!hasAwait(body)) return null;
  // store references to the counter OUTSIDE the loop pair are only safe
  // when they live in the loop's OWN function (same-function statements
  // run before/after the loop — the trailing sync keeps the store
  // truthful; refs in OTHER functions could execute DURING the loop and
  // see a stale store)
  if (storeRefsInOtherFunctions(program, name, initStmt, stmts[i])) return null;
  // no native identifier read/write of the name outside the pair either
  if (nativeUsesOutside(program, name, initStmt, stmts[i])) return null;
  // build the for: init = V = Number(INIT) (numeric literal kept as-is),
  // cond/body rewritten to the native binding, increment as the update
  const cond = rewriteCounterRefs(loop.cond, name);
  const newBody = body.slice(0, -1).map((s) => rewriteCounterRefs(s, name));
  const initVal = initE.arguments[1];
  const numeric = initVal && initVal.type === "Literal" && /^-?\d+$/.test(String(initVal.value));
  const forNode = {
    type: "ForStatement",
    init: {
      type: "AssignmentExpression", operator: "=",
      left: { type: "Identifier", name },
      right: numeric
        ? { type: "Literal", value: Number(initVal.value), raw: null }
        : { type: "CallExpression", callee: { type: "Identifier", name: "Number" }, arguments: [initVal], optional: false },
    },
    test: cond,
    update,
    body: { type: "BlockStatement", body: newBody },
  };
  const sync = {
    type: "ExpressionStatement",
    expression: {
      type: "CallExpression",
      callee: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: "setVar" } },
      arguments: [{ type: "Literal", value: name, raw: null }, { type: "Identifier", name }],
      optional: false,
    },
  };
  return { stmts: [forNode, sync], initIdx };
}

// Does a statement subtree reference (read OR write) the name — as a
// native identifier or a store string (`sh2.getVar("n")`, `"$n"` tokens)?
function touchesName(root, name) {
  let found = false;
  walk(root, (n) => {
    if (found) return;
    if (n.type === "Identifier" && n.name === name) { found = true; return; }
    if (n.type === "Literal" && typeof n.value === "string") {
      if (n.value === name || new RegExp("\\$\\{" + name + "\\}|\\$" + name + "(?![A-Za-z0-9_])").test(n.value)) found = true;
      return;
    }
    if (n.type === "TemplateLiteral") {
      for (const q of n.quasis || []) {
        const t = q.value && (q.value.cooked != null ? q.value.cooked : q.value.raw);
        if (t != null && new RegExp("\\$\\{" + name + "\\}|\\$" + name + "(?![A-Za-z0-9_])").test(String(t))) found = true;
      }
    }
  });
  return found;
}

// store-string mentions of `name` in OTHER functions than the loop's own
// (which could run while the loop is executing, when the store is stale
// — the trailing sync only fixes post-loop reads in the same function).
function storeRefsInOtherFunctions(program, name, initStmt, loopStmt) {
  // find the loop pair's enclosing function
  let loopFn = null;
  (function find(node, fn) {
    if (loopFn !== null || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) find(x, fn); return; }
    const next = node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
                 node.type === "ArrowFunctionExpression" ? node : fn;
    if (node === loopStmt) { loopFn = fn; return; }
    for (const k of Object.keys(node)) if (k !== "loc" && k !== "parent") find(node[k], next);
  })(program, null);
  let dangerous = false;
  const site = (n) => {
    if (n.type === "Literal" && typeof n.value === "string") {
      return String(n.value) === name ||
        new RegExp("\\$\\{" + name + "\\}|\\$" + name + "(?![A-Za-z0-9_])").test(String(n.value));
    }
    if (n.type === "TemplateLiteral") {
      for (const q of n.quasis || []) {
        const t = q.value && (q.value.cooked != null ? q.value.cooked : q.value.raw);
        if (t != null && new RegExp("\\$\\{" + name + "\\}|\\$" + name + "(?![A-Za-z0-9_])").test(String(t))) return true;
      }
    }
    return false;
  };
  const visit = (node, fn) => {
    if (dangerous || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) visit(x, fn); return; }
    if (node === initStmt || node === loopStmt) return;
    const next = node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
                 node.type === "ArrowFunctionExpression" ? node : fn;
    if (site(node) && fn !== loopFn) { dangerous = true; return; }
    for (const k of Object.keys(node)) if (k !== "loc" && k !== "parent") visit(node[k], next);
  };
  visit(program, null);
  return dangerous;
}

// Any `sh2.setVar("V", …)` write to the store counter (array writes like
// `setVar("a[$V]", …)` are NOT counter writes — they touch the array).
function writesStoreName(root, name) {
  let found = false;
  walk(root, (n) => {
    if (found) return;
    if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
        n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
        n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === "setVar" &&
        n.arguments && n.arguments[0] && n.arguments[0].type === "Literal" && n.arguments[0].value === name) found = true;
  });
  return found;
}

// Does the program use `name` as a native identifier outside the loop
// pair (reads, writes, params — anything but the hoisted declaration)?
// VariableDeclarator ids (the hoisted `let V = 0`) and object keys are
// not references.
function nativeUsesOutside(program, name, initStmt, loopStmt) {
  let found = false;
  const walkProg = (node) => {
    if (found || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node) walkProg(x); return; }
    if (node === initStmt || node === loopStmt) return;
    if (node.type === "Identifier" && node.name === name) { found = true; return; }
    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "parent") continue;
      if (k === "id" && node.type === "VariableDeclarator") continue; // the hoisted declaration
      if (k === "key" && node.type === "Property") continue;          // object keys aren't refs
      walkProg(node[k]);
    }
  };
  walkProg(program);
  return found;
}

// ── tryConvertWhile: recover a native `while` from ANY sync-cond loop ──
//
// The for-recoveries above need an induction variable; a loop that only
// runs the runtime dispatch — `await sh2.whileLoop(async () => COND,
// async () => { … })` — with a SYNC condition and an awaiting body is
// exactly a native `while (COND) { … }`. The runtime wrapper adds only a
// try/catch for break/continue and a maybeYield call; both are preserved
// by the guards:
//
//   • no sh2.break()/sh2.continue() in the body (a bare LoopSignal
//     would ESCAPE the native while and hit the wrong handler;
//     sh2.return/ReturnSignal propagates identically)
//   • the body must contain an await (an all-sync native loop would
//     never hit maybeYield — a huge pure loop could freeze the thread;
//     awaiting bodies yield at every exec/capture/sleep)
//
// Everything else — conditional increments, shared counter names across
// functions, non-last updates, store counters — only blocks the *for*
// recovery, not the loop dispatch, so those loops convert here.
function tryConvertWhile(stmts, i) {
  const loop = whileLoopParts(stmts[i]);
  if (!loop) return null;
  const body = loop.body;
  if (hasLoopSignal(body)) return null;
  if (!hasAwait(body)) return null;
  return {
    stmts: [{ type: "WhileStatement", test: loop.cond, body: { type: "BlockStatement", body } }],
    initIdx: -1,
  };
}

// `sh2.setVar("V", sh2.arithEval(() => (Number(sh2.getVar("V")) || 0) + K))`
// (or `- K`, without the ||-0 wrap) → the native update `V = V + K`.
// Returns the AssignmentExpression or null.
function storeIncrement(stmt, name) {
  if (!stmt || stmt.type !== "ExpressionStatement" || !stmt.expression) return null;
  const e = stmt.expression;
  if (e.type !== "CallExpression" || !e.callee || e.callee.type !== "MemberExpression" ||
      !e.callee.object || e.callee.object.type !== "Identifier" || e.callee.object.name !== "sh2" ||
      !e.callee.property || e.callee.property.type !== "Identifier" || e.callee.property.name !== "setVar" ||
      !e.arguments || !e.arguments[0] || e.arguments[0].type !== "Literal" || e.arguments[0].value !== name) return null;
  const rhs = e.arguments[1];
  if (!rhs || rhs.type !== "CallExpression" || !rhs.callee || rhs.callee.type !== "MemberExpression" ||
      !rhs.callee.object || rhs.callee.object.type !== "Identifier" || rhs.callee.object.name !== "sh2" ||
      !rhs.callee.property || rhs.callee.property.type !== "Identifier" || rhs.callee.property.name !== "arithEval" ||
      !rhs.arguments || !rhs.arguments[0]) return null;
  const arrow = rhs.arguments[0];
  const body = arrow && arrow.type === "ArrowFunctionExpression" ? (arrow.expression ? arrow.body : null) : null;
  if (!body || body.type !== "BinaryExpression" || (body.operator !== "+" && body.operator !== "-")) return null;
  // peel Number(x) and (x ?? 0) wrappers off the left operand
  // the emitter's `(Number(sh2.getVar("V")) || 0)` / `?? 0` guard — peel
  // it (the counter is a native number by then, so `|| 0` is a no-op)
  const peel = (x) => {
    if (x && x.type === "CallExpression" && x.callee && x.callee.type === "Identifier" && x.callee.name === "Number" &&
        x.arguments && x.arguments.length === 1) return peel(x.arguments[0]);
    if (x && x.type === "LogicalExpression" && (x.operator === "??" || x.operator === "||")) {
      const l = peel(x.left);
      if (x.right && x.right.type === "Literal" && (x.right.value === 0 || x.right.value === "0")) return l;
    }
    return x;
  };
  const isVarRead = (x) => x && x.type === "CallExpression" && x.callee && x.callee.type === "MemberExpression" &&
    x.callee.object && x.callee.object.type === "Identifier" && x.callee.object.name === "sh2" &&
    x.callee.property && x.callee.property.type === "Identifier" && x.callee.property.name === "getVar" &&
    x.arguments && x.arguments[0] && x.arguments[0].type === "Literal" && x.arguments[0].value === name;
  if (!isVarRead(peel(body.left))) return null;
  return {
    type: "AssignmentExpression", operator: "=",
    left: { type: "Identifier", name },
    right: { type: "BinaryExpression", operator: body.operator, left: { type: "Identifier", name }, right: rewriteCounterRefs(body.right, name) },
  };
}

// ── rewriteCounterRefs: rewrite store references to the counter `name`
//    inside a node to the native binding. Handles getVar("V") → V,
//    exact `"$V"` args of arrayIndex/arrayLen/param → the identifier, and
//    `$V`/`${V}` tokens inside string args (test strings, setVar/param
//    names like "a[$V]") → `${V}` interpolations in a template literal.
function rewriteCounterRefs(node, name) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => rewriteCounterRefs(n, name));
  if (node.type === "CallExpression" && node.callee && node.callee.type === "MemberExpression" &&
      node.callee.object && node.callee.object.type === "Identifier" && node.callee.object.name === "sh2" &&
      node.callee.property && node.callee.property.type === "Identifier" &&
      node.callee.property.name === "getVar" && node.arguments && node.arguments[0] &&
      node.arguments[0].type === "Literal" && node.arguments[0].value === name) {
    return { type: "Identifier", name };
  }
  if (node.type === "CallExpression" && node.callee && node.callee.type === "MemberExpression" &&
      node.callee.object && node.callee.object.type === "Identifier" && node.callee.object.name === "sh2" &&
      node.callee.property && node.callee.property.type === "Identifier" &&
      (node.callee.property.name === "arrayIndex" || node.callee.property.name === "arrayLen" || node.callee.property.name === "param")) {
    const out = { ...node };
    out.arguments = (node.arguments || []).map((a) =>
      a && a.type === "Literal" && a.value === "$" + name
        ? { type: "Identifier", name }
        : rewriteCounterRefs(a, name));
    return out;
  }
  if (node.type === "Literal" && typeof node.value === "string" && String(node.value).includes("$" + name)) {
    return interpolateString(node, name);
  }
  if (node.type === "TemplateLiteral") {
    let any = false;
    for (const q of node.quasis || []) {
      const t = q.value && (q.value.cooked != null ? q.value.cooked : q.value.raw);
      if (t != null && String(t).includes("$" + name)) any = true;
    }
    if (any) return interpolateTemplate(node, name);
  }
  const out = {};
  for (const k of Object.keys(node)) out[k] = rewriteCounterRefs(node[k], name);
  return out;
}

function splitOnVar(text, name) {
  const re = new RegExp("\\$\\{" + name + "\\}|\\$" + name + "(?![A-Za-z0-9_])", "g");
  const segs = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) });
    segs.push({ text: "", expr: name });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs;
}

// multi-name variant: ONE regex over all the lifted names, so a single
// program walk interpolates every "$var" token (the per-name
// rewriteCounterRefs loop was O(names × program) — 156 full walks ≈ 8s
// of the mimecroft transpile).
function splitOnVars(text, names) {
  // $name or ${name}, the longest name first so a prefix ("a" vs "ab")
  // never steals a longer match
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const re = new RegExp("\\$\\{(?:" + sorted.join("|") + ")\\}|\\$(?:" + sorted.join("|") + ")(?![A-Za-z0-9_])", "g");
  const segs = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) });
    const tok = m[0].startsWith("${") ? m[0].slice(2, -1) : m[0].slice(1);
    segs.push({ text: "", expr: tok });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs;
}

function interpolateStringMulti(node, names) {
  const segs = splitOnVars(String(node.value), names);
  if (segs.length === 1) return node;
  return templateFromSegments(segs);
}

function interpolateTemplateMulti(node, names) {
  const outQuasis = [], outExprs = [];
  const n = node.quasis.length;
  for (let i = 0; i < n; i++) {
    const q = node.quasis[i];
    const text = (q.value && q.value.cooked != null ? q.value.cooked : q.value.raw) || "";
    for (const seg of splitOnVars(String(text), names)) {
      if (seg.expr) outExprs.push({ type: "Identifier", name: seg.expr });
      else outQuasis.push({ type: "TemplateElement", value: { raw: toRaw(seg.text), cooked: seg.text }, tail: false });
    }
    if (i < node.expressions.length) outExprs.push(node.expressions[i]);
  }
  outQuasis[outQuasis.length - 1].tail = true;
  return { type: "TemplateLiteral", quasis: outQuasis, expressions: outExprs };
}

function toRaw(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function templateFromSegments(segments) {
  const quasis = [], expressions = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    quasis.push({ type: "TemplateElement", value: { raw: toRaw(seg.text), cooked: seg.text }, tail: i === segments.length - 1 });
    if (seg.expr) expressions.push({ type: "Identifier", name: seg.expr });
  }
  return { type: "TemplateLiteral", quasis, expressions };
}

function interpolateString(node, name) {
  const segs = splitOnVar(String(node.value), name);
  if (segs.length === 1) return node;
  return templateFromSegments(segs);
}

function interpolateTemplate(node, name) {
  const outQuasis = [], outExprs = [];
  const n = node.quasis.length;
  for (let i = 0; i < n; i++) {
    const q = node.quasis[i];
    const text = (q.value && q.value.cooked != null ? q.value.cooked : q.value.raw) || "";
    for (const seg of splitOnVar(String(text), name)) {
      // splitOnVar's expr segments carry no text — the `$name` token is
      // replaced by the expression alone; text segments become quasis
      if (seg.expr) outExprs.push({ type: "Identifier", name: seg.expr });
      else outQuasis.push({ type: "TemplateElement", value: { raw: toRaw(seg.text), cooked: seg.text }, tail: false });
    }
    if (i < node.expressions.length) outExprs.push(node.expressions[i]);
  }
  // a template literal must have exactly expressions.length + 1 quasis,
  // starting and ending with one (pad with empty quasis when the text
  // began or ended with a $name token)
  if (outExprs.length >= outQuasis.length) {
    outQuasis.unshift({ type: "TemplateElement", value: { raw: "", cooked: "" }, tail: false });
  }
  if (outExprs.length >= outQuasis.length) {
    outQuasis.push({ type: "TemplateElement", value: { raw: "", cooked: "" }, tail: true });
  }
  if (outQuasis.length) outQuasis[outQuasis.length - 1].tail = true;
  return { type: "TemplateLiteral", quasis: outQuasis, expressions: outExprs };
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
  const mergeList = (stmts) => {
    if (!Array.isArray(stmts) || stmts.length < 2) return;
    // name → { declIdx, declarator } for `let name = <literal>` decls
    const decls = new Map();
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i];
      if (stmt && stmt.type === "VariableDeclaration" && stmt.kind === "let") {
        for (const d of stmt.declarations) {
          if (d.id && d.id.type === "Identifier" && d.init && d.init.type === "Literal") {
            decls.set(d.id.name, { i, d });
          }
        }
      }
    }
    if (decls.size) {
      // ── one precompute pass over the list (paid once) ──
      // touchers: name → ascending statement indices that touch it (any
      // Identifier occurrence). writers: name → ascending indices that
      // WRITE it (assign-left / update / declarator) — the clobber check.
      // assigns[j] classifies a statement that is exactly `name = <rhs>`
      // (alsoRead = the name appears anywhere beyond the top-level left,
      // e.g. `x = x + 1` — then it is a read, not a foldable assign).
      // The OLD code re-walked every statement between each decl and its
      // first touch (O(decls × stmts) walks); the game's giant top-level
      // lists made mergeInitAssignments the ~8 s hot pass. This is
      // O(stmts) walks total + O(decls·log) lookups, same decisions.
      const touchers = new Map();
      const writers = new Map();
      const assigns = new Array(stmts.length);
      const touchAdd = (map, name, j) => {
        let a = map.get(name);
        if (!a) { a = []; map.set(name, a); }
        a.push(j);
      };
      for (let j = 0; j < stmts.length; j++) {
        const stmt = stmts[j];
        if (!stmt || typeof stmt !== "object") continue;
        if (
          stmt.type === "ExpressionStatement" && stmt.expression &&
          stmt.expression.type === "AssignmentExpression" &&
          stmt.expression.operator === "=" &&
          stmt.expression.left && stmt.expression.left.type === "Identifier"
        ) {
          assigns[j] = { name: stmt.expression.left.name, alsoRead: false };
        }
        walk(stmt, (n) => {
          if (n.type === "Identifier") {
            touchAdd(touchers, n.name, j);
            if (assigns[j] && n !== stmt.expression.left && n.name === assigns[j].name) {
              assigns[j].alsoRead = true;
            }
          } else if (n.type === "AssignmentExpression" && n.left && n.left.type === "Identifier") {
            touchAdd(writers, n.left.name, j);
          } else if (n.type === "UpdateExpression" && n.argument && n.argument.type === "Identifier") {
            touchAdd(writers, n.argument.name, j);
          } else if (n.type === "VariableDeclarator" && n.id && n.id.type === "Identifier") {
            touchAdd(writers, n.id.name, j);
          }
        });
      }
      // first element of ascending `arr` that is > i (−1 when none)
      const firstAfter = (arr, i) => {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (arr[mid] > i) hi = mid; else lo = mid + 1;
        }
        return lo < arr.length ? arr[lo] : -1;
      };
      const drop = new Set(); // statement indices to remove (the folded assigns)
      for (const [name, info] of decls) {
        const ts = touchers.get(name);
        const touchIdx = ts ? firstAfter(ts, info.i) : -1;
        if (touchIdx < 0) continue;
        const as = assigns[touchIdx];
        // foldable only when the first touch is the plain `name = …`
        // statement and `name` is not read anywhere else in it
        if (!as || as.name !== name || as.alsoRead) continue;
        const expr = stmts[touchIdx].expression;
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
          for (const r of reads) {
            const ws = writers.get(r);
            if (!ws) continue;
            const wIdx = firstAfter(ws, info.i);
            if (wIdx >= 0 && wIdx < touchIdx) { clobbered = true; break; }
          }
          if (clobbered) continue;
        }
        info.d.init = expr.right;
        drop.add(touchIdx);
      }
      if (drop.size) {
        const kept = [];
        for (let i = 0; i < stmts.length; i++) if (!drop.has(i)) kept.push(stmts[i]);
        stmts.length = 0;
        stmts.push(...kept);
      }
    }
    // merge adjacent `let` declarations into one (`let a = 1, b = 2;`)
    if (stmts.length > 1) {
      const merged = [];
      let cur = null;
      for (const s of stmts) {
        if (s && s.type === "VariableDeclaration" && s.kind === "let" && cur && cur.type === "VariableDeclaration" && cur.kind === "let") {
          cur.declarations.push(...s.declarations);
        } else {
          merged.push(s);
          cur = s;
        }
      }
      if (merged.length !== stmts.length) {
        stmts.length = 0;
        stmts.push(...merged);
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

// ─── backgroundDecide: `&` (sh2.background) → static thread-vs-fork ──
// The EMITTER decides at compile time what the runtime's old fork
// heuristic decided at run time, and annotates the generated code with
// the why. A backgrounded body whose subtree execs a nested
// `bash /examples/…` script (the texture/sound generators —
// self-contained pure compute; only args + stdout cross the boundary)
// is the THREAD case: it KEEPS the sh2.background runtime entry, whose
// worker hook routes the inner exec to a JS worker thread (a fresh
// runtime there — no parent shell state to copy, so the "cloning
// optimised out" note applies), and the main event loop (a game's
// settings menu) never blocks on generation. Everything else is the
// FORK case: it becomes NATIVE JS — `fn().catch(() => {})`, a detached
// promise — no runtime dispatch at all. Either way the generated code
// carries a comment saying which and why.
export function backgroundDecide(program) {
  const execsExamples = (n) => {
    if (!n || typeof n !== "object") return false;
    if (Array.isArray(n)) return n.some(execsExamples);
    if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
        n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
        n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === "exec" &&
        n.arguments && n.arguments[0] && n.arguments[0].type === "Literal" &&
        (n.arguments[0].value === "bash" || n.arguments[0].value === "/bin/bash") &&
        n.arguments[1] && n.arguments[1].type === "ArrayExpression" &&
        n.arguments[1].elements && n.arguments[1].elements[0]) {
      const a0 = n.arguments[1].elements[0];
      const pv = a0.type === "Literal" ? String(a0.value)
        : (a0.type === "TemplateLiteral" && a0.quasis && a0.quasis[0] ? String(a0.quasis[0].value.cooked) : null);
      return pv !== null && pv.startsWith("/examples/");
    }
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "range" || k === "start" || k === "end") continue;
      if (execsExamples(n[k])) return true;
    }
    return false;
  };

  const isBackgroundCall = (n) =>
    n && n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
    n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
    n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === "background" &&
    n.arguments && n.arguments[0];

  const forkIIFE = (fn) => ({
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      // pass the enclosing runtime (the wasm emits the background body
      // as `async (sh2) => …` — without the argument, sh2 is undefined
      // and the body throws silently, so the fork never runs)
      object: { type: "CallExpression", callee: fn, arguments: [{ type: "Identifier", name: "sh2" }] },
      property: { type: "Identifier", name: "catch" },
      computed: false, optional: false,
    },
    arguments: [{
      type: "ArrowFunctionExpression",
      id: null, params: [],
      body: { type: "BlockStatement", body: [] },
    }],
    optional: false,
  });

  const visit = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const c of n) visit(c); return; }
    if (n.type === "ExpressionStatement" && isBackgroundCall(n.expression)) {
      const fn = n.expression.arguments[0];
      // the A1 emits the background body as `async (sh2) => <stmt>` — an
      // arrow whose body is an ExpressionStatement (malformed ESTree;
      // astring prints it as `async sh2 => await x;` — the `;` lands
      // inside the call parens → `Unexpected token ';'`). Move the
      // statement into a real block body.
      if (fn && fn.body && fn.body.type !== "BlockStatement") {
        fn.body = { type: "BlockStatement", body: [fn.body] };
      }
      if (execsExamples(fn)) {
        // THREAD: keep the runtime entry — its worker hook routes the
        // inner bash /examples exec to a JS thread (fresh runtime, no
        // state copy); the menu stays responsive during generation.
        n.comments = [{
          type: "Line",
          value: " & → worker thread: nested bash /examples script (self-contained compute) — parallel generation, menu stays responsive",
        }];
      } else {
        // FORK: native async — no runtime dispatch (the runtime's fork
        // path was exactly this; a detached promise on the current
        // chain, shared shell state).
        n.comments = [{
          type: "Line",
          value: " & → fork: not a script exec — native async (no runtime dispatch)",
        }];
        n.expression = forkIIFE(fn);
      }
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "range" || k === "start" || k === "end") continue;
      visit(n[k]);
    }
  };
  visit(program);
  return program;
}
