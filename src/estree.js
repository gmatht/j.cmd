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

// the sh2 runtime's SYNC builtin table (src/sh2runtime.js `builtin`) —
// the fast commands the otranspilerl renders through sh2.builtin that
// the runtime handles synchronously. Any OTHER command the emitter
// routes to sh2.builtin is rewritten to the async exec bridge (see
// awaitSyncFnCalls) so it resolves through the shell like bash.
const SYNC_BUILTINS = new Set(["echo", "printf", "true", "false", "date", "pwd", "cat", "cd", "export", "ls", "test"]);

// the sync builtins whose return value IS their output (echo/printf
// format the args, date/pwd/cat/ls print state) — a statement-level
// sh2.builtin call for these must stream the return to stdout. Commands
// with no output (true/false/cd/export/test) are not in the set: their
// return is "" and the discard is harmless.
const OUTPUT_BUILTINS = new Set(["echo", "printf", "date", "pwd", "cat", "ls"]);

export async function estreeToJs(program, { repl = true, precompiledHead = false } = {}) {
  return (await estreeToJsMapped(program, null, null, { repl, precompiledHead })).js;
}

// ─── asyncCatCommandSubstitution: `$(cat FILE)` with a DYNAMIC path ──
// The estree backends lower `$(cat "/constant/path")` to the async
// sh2.fs.readFile bridge, but a dynamic path (`$(cat
// "…/sound-$cs_base.sh")` — the game's sound staging) falls back to
// the SYNC builtin cat, whose fs.readSync can't serve /examples (an
// async loader) → "" → the staged generator became just the lib.
// Rewrite that exact captureSync(builtin cat) shape to the async
// readFile bridge (capture awaits the fn). The sourced-C sync-cat form
// (sh2.builtin("cat") inside a function-body redirect) is NOT a
// captureSync call — untouched.
function asyncCatCommandSubstitution(program) {
  const isCatCapture = (call) =>
    call && call.type === "CallExpression" &&
    call.callee && call.callee.type === "MemberExpression" &&
    call.callee.object && call.callee.object.type === "Identifier" && call.callee.object.name === "sh2" &&
    call.callee.property && call.callee.property.type === "Identifier" && call.callee.property.name === "captureSync" &&
    call.arguments && call.arguments[0] && call.arguments[0].type === "ArrowFunctionExpression";
  // build the awaited `sh2.capture(() => sh2.exec("cat", [path]))` —
  // capture routes the fn's stdout writes into the buffer (the exec
  // dispatch writes there in capture mode) and the AWAIT matters: the
  // original captureSync was sync, so the wasm emitted the assignment
  // WITHOUT await — without the AwaitExpression, ss_x would hold the
  // promise object ("[object Promise]" leaked into the staged file).
  const rewrite = (call) => {
    const arrow = call.arguments[0];
    let body = arrow.body;
    if (body && body.type === "BlockStatement" && body.body && body.body.length === 1 &&
        body.body[0].type === "ExpressionStatement") body = body.body[0].expression;
    if (!(body && body.type === "CallExpression" &&
        body.callee && body.callee.type === "MemberExpression" &&
        body.callee.object && body.callee.object.type === "Identifier" && body.callee.object.name === "sh2" &&
        body.callee.property && body.callee.property.type === "Identifier" && body.callee.property.name === "builtin" &&
        body.arguments && body.arguments[0] && body.arguments[0].type === "Literal" && body.arguments[0].value === "cat" &&
        body.arguments[1] && body.arguments[1].type === "ArrayExpression" &&
        body.arguments[1].elements && body.arguments[1].elements.length === 1)) return call;
    const path = body.arguments[1].elements[0];
    const pv = path.type === "Literal" ? String(path.value) : null;
    if (pv === "-") return call;   // stdin — not a file read
    // only the ASYNC-loader mounts need this: a dynamic /examples path
    // (the game's sound staging) can't be served by the sync builtin
    // cat; /dev device reads and other paths stay sync. The await is
    // only valid in async contexts — the dynamic /examples cats (the
    // staging) live in async functions.
    const inExamples = (path.type === "Literal" && String(path.value).startsWith("/examples/")) ||
      (path.type === "TemplateLiteral" && path.quasis && path.quasis[0] &&
       String(path.quasis[0].value.cooked).startsWith("/examples/"));
    if (!inExamples) return call;
    return {
      type: "AwaitExpression",
      argument: {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          object: { type: "Identifier", name: "sh2" },
          property: { type: "Identifier", name: "capture" },
          computed: false, optional: false,
        },
        arguments: [{
          type: "ArrowFunctionExpression",
          id: null, params: [], body: {
            type: "CallExpression",
            callee: {
              type: "MemberExpression",
              object: { type: "Identifier", name: "sh2" },
              property: { type: "Identifier", name: "exec" },
              computed: false, optional: false,
            },
            arguments: [
              { type: "Literal", value: "cat", raw: "\"cat\"" },
              { type: "ArrayExpression", elements: [path] },
            ],
            optional: false,
          },
          async: false, expression: true, generator: false,
        }],
        optional: false,
      },
    };
  };
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) { if (isCatCapture(node[i])) node[i] = rewrite(node[i]); else walk(node[i]); } return; }
    for (const k of Object.keys(node)) {
      const child = node[k];
      if (Array.isArray(child)) { for (let i = 0; i < child.length; i++) { if (isCatCapture(child[i])) child[i] = rewrite(child[i]); else walk(child[i]); } }
      else if (child && typeof child === "object") { if (isCatCapture(child)) node[k] = rewrite(child); else walk(child); }
    }
  };
  walk(program);
}

// ─── writeBuiltinOutput: the otranspilerl/debashcl estree backends
// inline echo/printf with CONSTANT formats to process.stdout.write, but
// a printf whose FORMAT contains a variable lands as a bare
// `sh2.builtin("printf", [fmt])` statement whose return is DISCARDED —
// the transpiled texture generators' TSV header (`printf "#texture\t
// $NAME\t${SIZE}x${SIZE}…"`) emitted EMPTY stdout, so load_tex never
// saw a payload and blocks rendered flat. Rewrite statement-level
// sh2.builtin calls for the OUTPUT builtins so the formatted return
// reaches stdout — the same SequenceExpression shape the renderer uses
// for the native write (write → lastExit = 0 → true). The node is
// MUTATED in place (same statement object, one statement → one
// statement), so the source↔generated line map stays aligned.
export function writeBuiltinOutput(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(writeBuiltinOutput);
  const isOutBuiltin = (call) =>
    call && call.type === "CallExpression" &&
    call.callee && call.callee.type === "MemberExpression" &&
    call.callee.object && call.callee.object.type === "Identifier" &&
    call.callee.object.name === "sh2" &&
    call.callee.property && call.callee.property.type === "Identifier" &&
    call.callee.property.name === "builtin" &&
    call.arguments && call.arguments[0] &&
    call.arguments[0].type === "Literal" &&
    typeof call.arguments[0].value === "string" &&
    OUTPUT_BUILTINS.has(call.arguments[0].value);
  const isVarAssign = (call) =>
    // `printf -v NAME …` assigns to a variable and prints NOTHING —
    // wrapping it would both stream the return to stdout (wrong) and
    // break the var-assignment path (the PPM byte builder). Only the
    // non -v form has output to capture.
    call.arguments[0].value === "printf" &&
    call.arguments[1] && call.arguments[1].type === "ArrayExpression" &&
    call.arguments[1].elements && call.arguments[1].elements[0] &&
    call.arguments[1].elements[0].type === "Literal" &&
    call.arguments[1].elements[0].value === "-v";
  if (node.type === "ExpressionStatement" && node.expression) {
    // the awaited form (`await sh2.builtin("printf", [fmt])` — the
    // async-region lowering adds the await around the sync builtin):
    // unwrap it so the bare-call wrap below applies (the builtin is
    // sync, so the await is redundant once the return is streamed).
    let inner = node.expression;
    if (inner.type === "AwaitExpression" && inner.argument && inner.argument.type === "CallExpression" &&
        isOutBuiltin(inner.argument) && !isVarAssign(inner.argument)) {
      inner = inner.argument;
    }
    if (isOutBuiltin(inner) && !isVarAssign(inner)) {
      node.expression = {
        type: "SequenceExpression",
        expressions: [
          {
            type: "CallExpression",
            callee: {
              type: "MemberExpression", computed: false, optional: false,
              object: {
                type: "MemberExpression", computed: false, optional: false,
                object: { type: "Identifier", name: "process" },
                property: { type: "Identifier", name: "stdout" },
              },
              property: { type: "Identifier", name: "write" },
            },
            arguments: [inner],
            optional: false,
          },
          {
            type: "AssignmentExpression", operator: "=",
            left: {
              type: "MemberExpression", computed: false, optional: false,
              object: { type: "Identifier", name: "sh2" },
              property: { type: "Identifier", name: "lastExit" },
            },
            right: { type: "Literal", value: 0, raw: null },
          },
          { type: "Literal", value: true, raw: null },
        ],
      };
      return node;
    }
  }
  const out = {};
  for (const k of Object.keys(node)) out[k] = writeBuiltinOutput(node[k]);
  return out;
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

// ─── awaitSyncFnCalls: the otranspilerl estree backend emits the
// PROVABLY-SYNC fnCall form (`sh2.fnCall(...)` with no await) when it
// believes the target function is await-free. A C body containing a
// capture/whileLoop IS async, so the un-awaited call returns a pending
// promise and the caller's subsequent statements run BEFORE the callee
// (the demo for-loop prints the pre-sort array). Await every sh2.fnCall
// that isn't already inside an AwaitExpression — a no-op on a sync
// value, a correct sequencing fix on a promise.
// ─── awaitAsyncDirectCalls: a function the sync/direct analysis put in
// the DIRECT set can still be emitted ASYNC — awaitSyncFnCalls injects
// awaits into its body (the fnCall safety net) and markAsyncOnAwait then
// marks the arrow async. Its `sh2.callDirect("X", __fn_X, args)` call
// sites must await the returned promise or the call DETACHES: the
// caller's subsequent statements run before the callee, the callee's
// status/return value is dropped, and a long body churns on the
// microtask queue (starving timers) while the caller waits on one.
// After this pass the runtime's callDirect returns a promise only for
// async arrows, and every such call is awaited — sequencing is restored.
function awaitAsyncDirectCalls(program) {
  const asyncDirect = new Set();
  const walk = (n, visit) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) walk(x, visit); return; }
    visit(n);
    for (const k of Object.keys(n)) walk(n[k], visit);
  };
  walk(program, (n) => {
    if (n.type === "AssignmentExpression" && n.operator === "=" &&
        n.left && n.left.type === "Identifier" && n.left.name.startsWith("__fn_") &&
        n.right && n.right.type === "ArrowFunctionExpression" && n.right.async) {
      asyncDirect.add(n.left.name.slice(5));
    }
  });
  const rewrite = (n) => {
    if (!n || typeof n !== "object") return n;
    if (Array.isArray(n)) return n.map(rewrite);
    if (n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
        n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
        n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === "callDirect" &&
        n.arguments && n.arguments[0] && n.arguments[0].type === "Literal" &&
        asyncDirect.has(String(n.arguments[0].value))) {
      return { type: "AwaitExpression", argument: n };
    }
    const out = {};
    for (const k of Object.keys(n)) out[k] = rewrite(n[k]);
    return out;
  };
  return rewrite(program);
}

// ─── unwrapStoreString: the C frontend's assign lowering wraps every
// rhs store read in `String(sh2.vars.x)` — a BOXED pointer (the plan's
// `{arena, off, tag}` value) would stringify to "[object Object]".
// Rewrite `String(sh2.vars.x)` → `sh2.vars.x` (the read value itself):
// scalars keep working (the runtime getVar already returns strings),
// boxes survive the assignment. The shell env fallback chain
// `?? (sh2.env.x ?? "")` is preserved.
function unwrapStoreString(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(unwrapStoreString);
  if (node.type === "CallExpression" && node.callee && node.callee.type === "Identifier" &&
      node.callee.name === "String" && node.arguments && node.arguments.length === 1) {
    const a = node.arguments[0];
    const isStoreRead = (x) => x && x.type === "MemberExpression" && !x.computed &&
      x.object && x.object.type === "MemberExpression" && !x.object.computed &&
      x.object.object && x.object.object.type === "Identifier" && x.object.object.name === "sh2" &&
      x.object.property && x.object.property.type === "Identifier" && x.object.property.name === "vars" &&
      x.property && x.property.type === "Identifier";
    if (a && a.type === "LogicalExpression" && a.operator === "??" && isStoreRead(a.left)) {
      return unwrapStoreString(a);
    }
  }
  const out = {};
  for (const k of Object.keys(node)) out[k] = unwrapStoreString(node[k]);
  return out;
}

// ─── nullSentinel: a C pointer NULL check renders as `String(p) !== ""`
// (the structPtrCond lowering), but a chain tail stores the literal
// "0" (the frontend seeds `p = 0`), so the comparison must treat "0"
// as NULL too: `String(p) !== "" && String(p) !== "0"` / the "==" twin.
function nullSentinel(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(nullSentinel);
  if (node.type === "BinaryExpression" && (node.operator === "!==" || node.operator === "==") &&
      node.right && node.right.type === "Literal" && node.right.value === "" &&
      node.left && node.left.type === "CallExpression" && node.left.callee &&
      node.left.callee.type === "Identifier" && node.left.callee.name === "String") {
    const isNe = node.operator === "!==";
    const mk = (v) => ({ type: "BinaryExpression", operator: node.operator,
      left: nullSentinel(node.left), right: v === "" ? node.right : { type: "Literal", value: "0", raw: null } });
    return {
      type: "LogicalExpression", operator: isNe ? "&&" : "||",
      left: mk(""), right: mk("0"),
    };
  }
  const out = {};
  for (const k of Object.keys(node)) out[k] = nullSentinel(node[k]);
  return out;
}

// ─── returnInLoop: a C `return V` inside a while/for loop body. The
// renderer lowers the loop to `sh2.whileLoopSync(cond, () => { … })` —
// the body is an ARROW, so a plain `return` only exits the arrow and
// the loop spins forever (an infinite loop + OOM). Rewrite in-loop
// returns to `throw new sh2.ReturnSignal(V)`; the runtime loop rethrows
// and the fnCall/exec dispatch unwraps it as the function's value.
function returnInLoop(node, inLoop) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => returnInLoop(n, inLoop));
  if (node.type === "ReturnStatement" && inLoop && node.argument) {
    return {
      type: "ThrowStatement",
      argument: {
        type: "NewExpression",
        callee: { type: "MemberExpression", computed: false, optional: false,
          object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: "ReturnSignal" } },
        arguments: [returnInLoop(node.argument, false)],
      },
    };
  }
  if (node.type === "CallExpression" && node.callee && node.callee.type === "MemberExpression" &&
      node.callee.object && node.callee.object.type === "Identifier" && node.callee.object.name === "sh2" &&
      node.callee.property && node.callee.property.type === "Identifier" &&
      (node.callee.property.name === "whileLoop" || node.callee.property.name === "whileLoopSync" || node.callee.property.name === "forLoop") &&
      node.arguments && node.arguments.length > 1) {
    const out = { ...node };
    out.arguments = node.arguments.map((a, i) => returnInLoop(a, i === 1));
    return out;
  }
  const out = {};
  for (const k of Object.keys(node)) out[k] = returnInLoop(node[k], inLoop);
  return out;
}

// does a node subtree contain any AwaitExpression?
function hasAwait(node) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasAwait);
  if (node.type === "AwaitExpression") return true;
  for (const k of Object.keys(node)) if (hasAwait(node[k])) return true;
  return false;
}

// A function whose body contains an AwaitExpression must be `async` (a
// non-async function with `await` inside is a SyntaxError). awaitSyncFnCalls
// injects awaits into functions the frontend marked sync — fix the flag.
function markAsyncOnAwait(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(markAsyncOnAwait);
  if ((node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration") && node.body) {
    if (hasAwait(node.body)) node.async = true;
  }
  for (const k of Object.keys(node)) markAsyncOnAwait(node[k]);
  return node;
}

// ─── forceAsyncFileRedirects: the runtime's `redirectSync` twin ONLY
// handles fd-dup (`&N`) targets — a file target throws "redirection needs
// the async redirect bridge". The wasm's sync-twin decision for redirects
// with dynamic targets is order-dependent (hash-map ordering), so a file
// target can slip through as `redirectSync`. Enforce the rule here: any
// `sh2.redirectSync` whose specs contain a non-`&` target is rewritten to
// the async `sh2.redirect` (wrapped in await), so the fs bridge handles
// it — deterministic, regardless of the emitter's verdict.
function forceAsyncFileRedirects(program) {
  const rewrite = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(rewrite);
    if (node.type === "CallExpression" && node.callee && node.callee.type === "MemberExpression" &&
        node.callee.object && node.callee.object.type === "Identifier" && node.callee.object.name === "sh2" &&
        node.callee.property && node.callee.property.type === "Identifier" && node.callee.property.name === "redirectSync" &&
        node.arguments && node.arguments.length === 2) {
      const specs = node.arguments[1];
      let fileTarget = false;
      if (specs && specs.type === "ArrayExpression") {
        for (const el of specs.elements) {
          if (!el || el.type !== "ObjectExpression") continue;
          for (const p of el.properties) {
            const k = p.key && (p.key.name || p.key.value);
            if (k !== "target") continue;
            const v = p.value;
            const lit = v && v.type === "TemplateLiteral" && v.expressions.length === 0 && v.quasis.length === 1
              ? v.quasis[0].value.cooked : (v && v.type === "Literal" ? String(v.value) : null);
            if (lit === null || !lit.startsWith("&")) fileTarget = true;
          }
        }
      }
      if (fileTarget) {
        const out = {
          type: "CallExpression",
          callee: { ...node.callee, property: { ...node.callee.property, name: "redirect" } },
          arguments: node.arguments.map(rewrite),
          optional: node.optional,
        };
        return { type: "AwaitExpression", argument: out };
      }
    }
    const out = {};
    for (const k of Object.keys(node)) out[k] = rewrite(node[k]);
    return out;
  };
  return rewrite(program);
}


function awaitSyncFnCalls(node, inAwait, inSync) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => awaitSyncFnCalls(n, false, inSync));
  if (node.type === "AwaitExpression") {
    return { ...node, argument: awaitSyncFnCalls(node.argument, true, inSync) };
  }
  // a *Sync twin's body arrow was PROVEN await-free by the emitter — a
  // fnCall inside it targets a sync function (else the twin would not
  // have been chosen); awaiting it would flip the arrow async and make
  // the sync twin throw "async result". Keep those fnCalls un-awaited.
  if (node.type === "CallExpression" && node.callee && node.callee.type === "MemberExpression" &&
      node.callee.object && node.callee.object.type === "Identifier" && node.callee.object.name === "sh2" &&
      node.callee.property && node.callee.property.type === "Identifier" &&
      /^(capture|redirect|pipeline|subshell|block|whileLoop|forLoop|cstyleFor)Sync$/.test(node.callee.property.name)) {
    return {
      ...node,
      arguments: node.arguments.map((a) => awaitSyncFnCalls(a, false, true)),
    };
  }
  if (node.type === "CallExpression" && node.callee && node.callee.type === "MemberExpression" &&
      node.callee.object && node.callee.object.type === "Identifier" && node.callee.object.name === "sh2" &&
      node.callee.property && node.callee.property.type === "Identifier" && node.callee.property.name === "fnCall" &&
      !inAwait && !inSync) {
    return {
      type: "AwaitExpression",
      argument: { ...node, arguments: node.arguments.map((a) => awaitSyncFnCalls(a, false, inSync)) },
    };
  }
  if (node.type === "CallExpression" && node.callee && node.callee.type === "MemberExpression" &&
      node.callee.object && node.callee.object.type === "Identifier" && node.callee.object.name === "sh2" &&
      node.callee.property && node.callee.property.type === "Identifier" && node.callee.property.name === "builtin" &&
      node.arguments && node.arguments[0] && node.arguments[0].type === "Literal" &&
      typeof node.arguments[0].value === "string" &&
      !SYNC_BUILTINS.has(node.arguments[0].value) &&
      !inAwait) {
    // the otranspilerl transpile renders SIMPLE commands as the SYNC
    // sh2.builtin, but the sh2 runtime's sync table only carries the
    // fast common commands (echo/cat/test/ls/…) — anything else (cp,
    // sed, mv, …) would hit "command not found" from the sync table.
    // Rewrite to the async exec bridge, which resolves the command
    // through the shell (shared builtins + uutils wasm). This is the
    // same shape as the old `.`/source-only case (source resolves via
    // the shell's shared implementation); a bare `.` falls here too.
    return {
      type: "AwaitExpression",
      argument: {
        type: "CallExpression",
        callee: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: "exec" } },
        arguments: [
          { type: "Literal", value: node.arguments[0].value, raw: null },
          node.arguments[1] ? awaitSyncFnCalls(node.arguments[1], false, inSync) : { type: "ArrayExpression", elements: [] },
        ],
        optional: false,
      },
    };
  }
  const out = {};
  for (const k of Object.keys(node)) out[k] = awaitSyncFnCalls(node[k], false, inSync);
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
  // the registration arrows are re-scanned per-owner below — skipping them
  // here keeps "top" as GENUINE top-level use only (a var with a real
  // top-level write AND a function read must stay module-level, e.g. the
  // game's persistent `seed` the LCG `rand` advances).
  const arrowSkips = new Set(registrations.map((r) => r.arrow));
  const walkUsage = (node, owner, skip) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walkUsage(n, owner, skip); return; }
    const skipped = skip.has(node);
    if (!skipped && isSh2Vars(node) && node.property.type === "Identifier") {
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
    for (const k of Object.keys(node)) walkUsage(node[k], owner, skip);
  };
  walkUsage(program.body, "top", arrowSkips);
  for (const r of registrations) {
    // add the arrow's OWN uses under its fnName (the initial scan skipped
    // the arrows, so nothing to remove — a genuine top-level use stays).
    const walkArrow = (node, owner) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) walkArrow(n, owner); return; }
      if (isSh2Vars(node) && node.property.type === "Identifier") {
        const name = node.property.name;
        if (!usage.has(name)) usage.set(name, new Set());
        usage.get(name).add(owner);
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
    // `"$X"` / `"map[$X]"` / `"$X + 1"` — string literals that reference
    // a param/local BY NAME (the runtime's `$var` expansion reads the
    // STORE; a normalized param/local is a native JS variable the store
    // never sees — the expansion would answer "" and arrayIndex/setVar/
    // arith would read/write the WRONG element). Interpolate the native
    // variable into a template literal so the value travels with the
    // call. `$N` positional refs bind to the consumed params too.
    const interpolateDollarVars = (str) => {
      const segs = []; // alternating text / {expr} starting with text
      let re = /\$(\$|[A-Za-z_][A-Za-z0-9_]*|[1-9][0-9]*)/g;
      let last = 0, hit = false;
      for (let m = re.exec(str); m; m = re.exec(str)) {
        if (m[1] === "$") { continue; }
        let nm = null;
        if (/^[A-Za-z_]/.test(m[1])) {
          if (paramNames.has(m[1]) || locals.has(m[1])) nm = m[1];
        } else {
          const p = paramByPos.get(Number(m[1]) - 1);
          if (p) nm = p;
        }
        if (!nm) continue;
        hit = true;
        segs.push(str.slice(last, m.index));
        segs.push({ expr: { type: "Identifier", name: nm } });
        last = m.index + m[0].length;
      }
      if (!hit) return null;
      segs.push(str.slice(last));
      return {
        type: "TemplateLiteral",
        quasis: segs.filter((s, i) => i % 2 === 0).map((t, i, arr) => ({
          type: "TemplateElement",
          value: { raw: t, cooked: t },
          tail: i === arr.length - 1,
        })),
        expressions: segs.filter((s) => s && typeof s === "object").map((s) => s.expr),
      };
    };
    // rewrite store access → native identifiers inside the body
    const rewrite = (node) => {
      if (!node || typeof node !== "object") return node;
      if (Array.isArray(node)) return node.map(rewrite);
      // a `$X` literal naming a param/local → interpolate the native var
      if (node.type === "Literal" && typeof node.value === "string") {
        const tpl = interpolateDollarVars(node.value);
        if (tpl) return tpl;
      }
      // `sh2.positional[N] ?? ""` / `String(sh2.positional[N] ?? "")` that
      // names one of THIS function's params → the parameter identifier
      const positionalName = (n) => {
        if (!n || n.type !== "LogicalExpression" || n.operator !== "??") return null;
        const l = n.left;
        if (!l || l.type !== "MemberExpression" || !l.object || l.object.type !== "MemberExpression" ||
            !l.object.object || l.object.object.name !== "sh2" || !l.object.property || l.object.property.name !== "positional" ||
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
    // The bash function's `$1`-assignments became JS params, so the body's
    // STORE-string references (`sh2.setVar("map[$ms_i]", v)` — the emitter
    // passes bash index TEXT the runtime expands via getVar) would see the
    // param name as "" in the store → Number("") = 0 → every indexed write
    // collapses to element 0 (the game's map became a single cell; the maze
    // sprinkle loop never saw STONE and spun forever). Bind each param into
    // the store on entry (`sh2.setVar(p, p)`) — bash semantics (a function
    // param IS a shell variable during the body) — the same prologue the
    // Lambda/arrow path already emits.
    const paramStorePrologue = params.length ? [{
      type: "ExpressionStatement",
      expression: {
        type: "SequenceExpression",
        expressions: params.map((p) => ({
          type: "CallExpression",
          callee: { type: "MemberExpression", computed: false, optional: false, object: { type: "Identifier", name: "sh2" }, property: { type: "Identifier", name: "setVar" } },
          arguments: [{ type: "Literal", value: p.name, raw: null }, { type: "Identifier", name: p.name }],
          optional: false,
        })),
      },
    }] : [];
    const fnBlock = {
      type: "BlockStatement",
      body: [
        ...(localDecls.length ? [{ type: "VariableDeclaration", kind: "let", declarations: localDecls.map((n) => ({ type: "VariableDeclarator", id: { type: "Identifier", name: n }, init: { type: "Literal", value: "", raw: null } })) }] : []),
        ...paramStorePrologue,
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
      // the bash frontend sometimes marks a function async:false even
      // though its body awaits a runtime bridge (sh2.fnCall on another
      // user function, sh2.capture/whileLoop) — a non-async function
      // with `await` inside is a SyntaxError, so force async when the
      // body actually contains an AwaitExpression.
      async: !!r.arrow.async || hasAwait(fnBlock),
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
    for (let i = 0; i < newBody.length; i++) {
      const st = newBody[i];
      if (st.type === "VariableDeclaration" && st.declarations) {
        st.declarations = st.declarations.filter((d) => !(d.id && d.id.type === "Identifier" && moved.has(d.id.name)));
        if (st.declarations.length === 0) { newBody.splice(i, 1); i--; }  // all params moved → drop the empty `let ;`
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
// ─── reclassAsyncLoops: the direct-call rewrite (directShellFnCalls)
// can inject an AwaitExpression into a body the frontend classified
// SYNC — a direct call of an async target is awaited wherever it sits,
// including inside a `sh2.whileLoopSync(cond, () => …)` body (the
// sync-direct-call-await regression: a stderr redirect makes the callee
// async, the direct call is awaited, and the non-async arrow carrying
// that `await` is a SyntaxError). The sync twin would ALSO spin without
// awaiting the async body — so flip such loops to the async
// `sh2.whileLoop`, await the loop at its call site, and mark every
// enclosing function whose body now awaits as async.
function reclassAsyncLoops(program) {
  const hasAwaitOwn = (n) => {
    if (!n || typeof n !== "object") return false;
    if (Array.isArray(n)) return n.some(hasAwaitOwn);
    if (n.type === "AwaitExpression") return true;
    // an await inside a NESTED function belongs to that function — the
    // outer body doesn't need the flag for it
    if (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" || n.type === "FunctionDeclaration") return false;
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "range" || k === "start" || k === "end") continue;
      if (hasAwaitOwn(n[k])) return true;
    }
    return false;
  };
  const isWhileLoopSync = (n) =>
    n && n.type === "CallExpression" && n.callee && n.callee.type === "MemberExpression" &&
    n.callee.object && n.callee.object.type === "Identifier" && n.callee.object.name === "sh2" &&
    n.callee.property && n.callee.property.type === "Identifier" && n.callee.property.name === "whileLoopSync";
  const visit = (n, parent) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const c of n) visit(c, n); return; }
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "range" || k === "start" || k === "end") continue;
      visit(n[k], n);
    }
    if (isWhileLoopSync(n)) {
      const body = n.arguments && n.arguments[1];
      if (body && body.type === "ArrowFunctionExpression" && hasAwaitOwn(body.body)) {
        n.callee.property.name = "whileLoop";
        body.async = true;
        if (parent && parent.type === "ExpressionStatement") {
          parent.expression = { type: "AwaitExpression", argument: n };
        }
      }
    }
    if ((n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" || n.type === "FunctionDeclaration") && n.body && hasAwaitOwn(n.body)) {
      n.async = true;
    }
  };
  visit(program, null);
  return program;
}

export async function estreeToJsMapped(program, stmtLines, a1Stmts, { repl = true, precompiledHead = false } = {}) {
  const lowerMod = await import("./lower.js");
  const { lowerNativeArrays, hoistLoopLastExit, hoistCommonLastExit, dropDeadFlags, mergeInitAssignments, pushLastExitToEnd, nativeForLoops, lowerPureFunctions, flattenAndOrAll, lowerDeviceRedirects, directShellFnCalls, liftLocalVars, nativeArrays, lowerI32Trunc, backgroundDecide, safeWordListCoercion, paramLiveValue, plainIfTests } = lowerMod;
  // ── transpile progress: the whole-game transpile can take seconds;
  // once it exceeds 500ms, stream `[n/m passes completed (xx%)]` per
  // pass so the terminal shows forward progress instead of a silent
  // wait (the browser can paint the shell between the pass awaits).
  // stderr — never corrupts a stdout capture. The `m` comes from the
  // passChain array length below — exact, no magic constant.
  const PROGRESS_MS = 500;
  let passT0 = Date.now(), passOn = false;
  const passProgress = (done, total, name) => {
    if (!passOn) {
      if (Date.now() - passT0 <= PROGRESS_MS) return;
      passOn = true;
    }
    const line = `[${done}/${total} passes completed (${Math.min(100, Math.round((done / total) * 100))}%)] — ${name}`;
    // surface the transpile progress on a SINGLE line of the j.cmd
    // Terminal, not the web console — devtools is invisible to the
    // user. The shell sets `globalThis.__sh2PassProgress` (index.html)
    // to a single overwriting stderr line (`write("\r"+line, "err")`);
    // the terminal's write() treats a leading \r as "replace the
    // current line". The send func passes the \r-prefix + a trailing-
    // newline flag (the shell appends \n on the LAST pass). Without the
    // hook (Node CLI / unit tests — captured stdout must stay clean) we
    // fall back to the console for the benchmark/debug path.
    const hook = globalThis.__sh2PassProgress;
    if (typeof hook === "function") {
      hook(`\r${line}`, done, total);
    } else {
      (console.error || console.log)(line);
    }
  };
  // awaitSyncFnCalls must run BEFORE normalizeFunctions: the sync-fnCall
  // form (a fnCall the frontend believes is await-free) becomes an
  // AwaitExpression here; markAsyncOnAwait then sets async on every
  // function whose body awaits (a non-async function with `await` inside
  // is a SyntaxError), and normalizeFunctions keeps the flag.

  // ── the pass chain as a data-driven pipeline ────────────────────
  // Each entry names a pass and runs it against the scoped AST
  // (`normalized` until the lowerNativeArrays switch, then `lowered`).
  // The precompiledHead / repl / typeof guards live inside the closures;
  // iterating the ARRAY drives the progress counter, so [n/m] and the
  // percentage are exact (the array length is the total) as passes are
  // added or removed.
  let normalized = precompiledHead ? program : null;
  let lowered = null;
  let js = "";
  let genFn = null;   // the astring code generator (set by the generate pass)
  const passChain = [
    // the whole frontend expression (bash → ESTree via the A1 renderers)
    ["normalizeFunctions", () => { if (!precompiledHead) normalized = normalizeFunctions(awaitAsyncDirectCalls(markAsyncOnAwait(forceAsyncFileRedirects(awaitSyncFnCalls(stripProcessEnv(program), false))))); }],
    // The wasm compile path has already run its head passes, but it has not
    // run this JS-side safety rewrite. Keep file redirects on the async
    // bridge even when the backend classified the enclosing function as
    // sync: VirtualFS.write is asynchronous, while redirectSync cannot
    // await it. Without this pass, generated programs can race the next
    // command (MIMEcroft's sh2glsl read saw an empty fragment file).
    ["forceAsyncFileRedirects", () => { normalized = forceAsyncFileRedirects(normalized); }],
    // the first five run only on the non-precompiled path (the wasm
    // compile already did them)
    ["unwrapStoreString*", () => { if (!precompiledHead) normalized = unwrapStoreString(normalized); }],
    ["nullSentinel*", () => { if (!precompiledHead) normalized = nullSentinel(normalized); }],
    ["returnInLoop*", () => { if (!precompiledHead) normalized = returnInLoop(normalized, false); }],
    ["directShellFnCalls*", () => { if (!precompiledHead) normalized = directShellFnCalls(normalized); }],
    ["reclassAsyncLoops*", () => { if (!precompiledHead) normalized = reclassAsyncLoops(normalized); }],
    ["unwrapStoreString", () => { normalized = unwrapStoreString(normalized); }],
    ["nullSentinel", () => { normalized = nullSentinel(normalized); }],
    ["returnInLoop", () => { normalized = returnInLoop(normalized, false); }],
    // the A1 word-split on dispatch args must be coerced safely first
    // (a NUMBER var has no .split — the game's load_textures crashed at
    // `tex_bg_done $sm_bg_i`); the pass mutates the tree in place
    ["safeWordListCoercion", () => { safeWordListCoercion(normalized); }],
    // `${v#pat}` strips carry the live value so a module-lifted var
    // (whose store copy is never written) strips correctly
    ["paramLiveValue", () => { paramLiveValue(normalized); }],
    // directShellFnCalls: the shell functions became native declarations
    // but their call sites stayed sh2.fnCall/callDirect dispatches —
    // direct them now (the texture generators' per-pixel helpers are the
    // measured hot cost)
    ["directShellFnCalls", () => { normalized = directShellFnCalls(normalized); }],
    // the direct-call rewrite can insert awaits into a body typed SYNC —
    // flip such sync loop twins + mark the enclosing functions async
    ["reclassAsyncLoops", () => { normalized = reclassAsyncLoops(normalized); }],
    // lift single-function store locals to native bindings + drop the
    // dead param-sync writes (the measured per-frame store round-trips)
    ["liftLocalVars", () => { normalized = liftLocalVars(normalized); }],
    // fold store-backed arrays (map, an, GMASK, mime_lookup…) to native
    // module bindings — whole-script evals only (repl: false): a REPL
    // line's array must stay in the store for the NEXT line to read it
    ["nativeArrays", () => { if (!repl) normalized = nativeArrays(normalized); }],
    // Math.trunc(<i32-provable compound>) → (<compound>) | 0
    ["lowerI32Trunc", () => { normalized = lowerI32Trunc(normalized); }],
    // keepVariables (the A1 path's array pre-seeding): the wasm lowers
    // `a=(...)` to sh2.setArray only for flagged arrays — the module
    // arrays (DIR_X, DIR_Z, CAM_YAW, TREASURES, GFONT …) arrive as plain
    // `let` declarators and the store would read empty → sync them
    ["keepVariables", () => { keepVariables(normalized, [], { repl }); }],
    ["lowerNativeArrays", () => { lowered = lowerNativeArrays(normalized); }],
    ["hoistLoopLastExit", () => { hoistLoopLastExit(lowered); }],
    ["hoistCommonLastExit", () => { hoistCommonLastExit(lowered); }],
    ["dropDeadFlags", () => { dropDeadFlags(lowered); }],
    ["pushLastExitToEnd", () => { pushLastExitToEnd(lowered); }],
    ["mergeInitAssignments", () => { mergeInitAssignments(lowered); }],
    // a stale cached lower.js without a new pass must not break the
    // game — the typeof guards keep the while-loop form working
    ["nativeForLoops", () => { if (typeof nativeForLoops === "function") nativeForLoops(lowered); }],
    ["flattenAndOrAll", () => { if (typeof flattenAndOrAll === "function") flattenAndOrAll(lowered); }],
    ["lowerDeviceRedirects", () => { if (typeof lowerDeviceRedirects === "function") lowerDeviceRedirects(lowered); }],
    ["lowerPureFunctions", () => { if (typeof lowerPureFunctions === "function") lowerPureFunctions(lowered); }],
    // statement-level sh2.builtin calls for the OUTPUT builtins must
    // stream their return to stdout (a printf with a variable in its
    // format is otherwise emitted as a bare call whose value is
    // discarded — the texture generators' TSV header vanished)
    ["writeBuiltinOutput", () => { writeBuiltinOutput(lowered); }],
    // `$(cat "/constant/path")` → the async readFile bridge (a dynamic
    // path falls back to the sync builtin cat whose fs.readSync can't
    // serve /examples)
    ["asyncCatCommandSubstitution", () => { asyncCatCommandSubstitution(lowered); }],
    // `&` (sh2.background): classify each backgrounded body statically
    // (thread vs fork); fork bodies become native fn().catch(() => {})
    ["backgroundDecide", () => { if (typeof backgroundDecide === "function") backgroundDecide(lowered); }],
    // astring — the JS code generation
    // strip the dead `$?` framing from IF conditions (the condition
    // value is the only consumer — the lastExit set inside is always
    // overwritten before any read; 0/421 consumed in mimecroft)
    ["plainIfTests", () => { if (typeof plainIfTests === "function") plainIfTests(lowered); }],
    ["generate", async () => { genFn = (await getAstring()).generate; js = genFn(lowered, { comments: true }); }],
  ];
  for (let i = 0; i < passChain.length; i++) {
    await passChain[i][1]();
    passProgress(i + 1, passChain.length, passChain[i][0]);
    // let the browser PAINT the progress line: awaiting each (mostly sync)
    // pass only schedules microtasks, which the compositor batches until a
    // macrotask — so without a real yield the whole transpile blocks paint
    // and the user sees the banner + settings only AFTER it finishes. Yield
    // a macrotask between passes when a progress sink is active (the shell
    // browser sets __sh2PassProgress; Node/tests don't, so no slowdown).
    if (typeof globalThis.__sh2PassProgress === "function" && i < passChain.length - 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

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
    const one = genFn({ type: "Program", body: [st] });
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
export function keepVariables(program, knownArrays = [], { repl = true } = {}) {
  // `repl: false` — a WHOLE SCRIPT (one eval, fresh runtime — no
  // cross-line persistence needed). The wasm's lowerNativeArrays output
  // (`let a = [...]`) is a valid native binding for the script; the REPL
  // re-routes those arrays through the store so the value survives to the
  // NEXT transpiled line (seed/harvest) — but for a script that routing
  // would only undo the native lowering and slow every read (the game's
  // per-frame DIR_X/DIR_Z reads). So in script mode we detect the native
  // declarators and LEAVE them native.
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
  // The wasm's lowerNativeArrays output — `let a = […]` declarators —
  // is a NATIVE binding valid inside this eval. The REPL re-routes them
  // through the store (the value must survive to the next line); a whole
  // script (repl: false) keeps them native (the reads are already native
  // — routing them to sh2.arrayIndex would be pure overhead). "other
  // pipelines" that emit the same `let` form get the same treatment.
  const nativeArrays = new Set();
  for (const st of program.body || []) {
    if (st.type === "VariableDeclaration" && st.declarations) {
      for (const d of st.declarations) {
        if (d.id && d.id.type === "Identifier" && d.init && d.init.type === "ArrayExpression") {
          if (repl) known.add(d.id.name);
          else nativeArrays.add(d.id.name);
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
        known.has(node.object.name) && !nativeArrays.has(node.object.name)) {
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
      if (d && d.id && d.id.type === "Identifier" && d.init && d.init.type === "ArrayExpression" && known.has(d.id.name) && !nativeArrays.has(d.id.name)) {
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
    // MULTI-declarator `let a = [...], b = [...], c = 1, …` — the game's
    // module arrays arrive in ONE statement (DIR_X, DIR_Z, CAM_YAW,
    // TREASURES, MIME_DMG, GFONT …). The single-declarator branch above
    // skips these, so the arrays stay JS-local-only: `sh2.arrayIndex("DIR_X",
    // "$yaw")` then reads an EMPTY store → the facing vectors were "" → the
    // shot ray went (0,0) (straight ahead never moved) and the maze
    // direction reads desynced. Split the array declarators out: keep the
    // scalars/__fn_ bindings in `let`, emit each known array as an
    // assignment + `sh2.setArray` store sync.
    if (st.type === "VariableDeclaration" && st.declarations && st.declarations.length > 1) {
      const arrayDecls = [];
      const rest = [];
      for (const d of st.declarations) {
        if (d && d.id && d.id.type === "Identifier" && d.init && d.init.type === "ArrayExpression" && known.has(d.id.name) && !nativeArrays.has(d.id.name)) {
          arrayDecls.push(d);
        } else {
          rest.push(d);
        }
      }
      if (arrayDecls.length) {
        if (rest.length) {
          out.push({ type: "VariableDeclaration", kind: st.kind || "let", declarations: rest });
        }
        for (const d of arrayDecls) {
          out.push({
            type: "ExpressionStatement",
            expression: { type: "AssignmentExpression", operator: "=", left: id(d.id.name), right: d.init },
          });
          out.push(Object.assign({
            type: "ExpressionStatement",
            expression: call(member(id("sh2"), id("setArray")), [lit(d.id.name), id(d.id.name)]),
          }, { _sh2Sync: true }));
        }
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
  // REPL-only: a whole script has no next line.
  let out2 = out;
  if (repl) {
    out2 = [];
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
