# PLAN — move the estreeToJs pipeline into the wasm

**Goal**: the sh→js path becomes `bash → otranspilerl.wasm → JS string` — one
boundary crossing, no AST JSON round-trip, no JS-side pass layer. The 22
`estreeToJsMapped` passes + the astring codegen move into `estree.rs` (the
wasm's sh2-targeted backend). The REPL + the stateful callers keep the
JS-side pipeline; the environment-coupled passes move last, driven by a
small config option.

---

## 1. Current state (measured)

Game transpile (~2.6 s): wasm 700 ms · JSON.parse 85 ms · **estreeToJs 1900 ms**.

The wasm ALREADY runs five of these passes in Rust at the `shir_to_estree`
level (shir.rs ~13829): `fix_control_flow`, `hoist_last_exit`,
`lower_native_arrays`, `drop_dead_flags`, `drop_dead_top_decls`. The JS-side
versions of the same passes (`hoistLoopLastExit`, `lowerNativeArrays`,
`dropDeadFlags`, …) were written later with more complete semantics — so the
move is partly *consolidation* (adopt the JS semantics into the Rust twins),
not port-from-scratch.

## 2. The inventory (22 passes + the codegen)

| # | pass | category | notes |
|---|---|---|---|
| 1 | `stripProcessEnv` | **env** | `process.env` → the env accessor |
| 2 | `awaitSyncFnCalls` | agnostic | fnCall safety-net await |
| 3 | `forceAsyncFileRedirects` | **env** | the redirect sync/async twin rule (the fs bridge) |
| 4 | `markAsyncOnAwait` | agnostic | pure JS correctness (async marking) |
| 5 | `awaitAsyncDirectCalls` | agnostic | callDirect await |
| 6 | `normalizeFunctions` | agnostic | `sh2.functions.set` → native declarations |
| 7 | `unwrapStoreString` | agnostic | the `sh2.vars` store-string model |
| 8 | `nullSentinel` | agnostic | pure JS correctness (`?? ""`) |
| 9 | `returnInLoop` | agnostic | the `sh2.*Loop` body-arrow return contract |
| 10 | `directShellFnCalls` | agnostic | dispatch → direct calls |
| 11 | `reclassAsyncLoops` | agnostic | `whileLoopSync`/`whileLoop` twins |
| 12 | `keepVariables` | agnostic | store seeding + native arrays (repl-mode via opts) |
| 13 | `lowerNativeArrays` | agnostic | `sh2.setArray`/`getVar`/`arrayIndex` → native |
| 14 | `hoistLoopLastExit` | agnostic | the `sh2.lastExit` machinery |
| 15 | `hoistCommonLastExit` | agnostic | the `sh2.lastExit` machinery |
| 16 | `dropDeadFlags` | agnostic | the `sh2.lastExit` machinery |
| 17 | `pushLastExitToEnd` | agnostic | the `sh2.lastExit` machinery |
| 18 | `mergeInitAssignments` | agnostic | the de-quadratized let-fold |
| 19 | `nativeForLoops` | agnostic | counter while-loops → native `for` |
| 20 | `flattenAndOrAll` | agnostic | `sh2.and()`/`or()` → `&&`/`||` |
| 21 | `lowerDeviceRedirects` | **env** | the `/dev/*` device namespace |
| 22 | `lowerPureFunctions` | agnostic | `sh2.define` pure helpers → native |
| 23 | `writeBuiltinOutput` | **env** | the stdout shape (`process.stdout.write`) |
| — | astring `generate` | generic | the codegen (port to Rust) |

**19 environment-agnostic, 4 environment-coupled** (1, 3, 21, 23), 1 generic
codegen. "Agnostic" = pure AST transforms, no environment state — portable
as-is. The 4 env-coupled are also pure rewrites but their *correctness*
depends on the environment's contract (`/dev` namespace, fs-bridge rule,
stdout shape, env accessor) — they move with a config option (Phase 2).

## 3. Phases

> **Status 13 (2026-08-15): the divergence ROOT is found — the post-#11 trees
> differ between my Rust (2982258 chars) and the worker's CURRENT JS
> (2974503) — the worker's liftLocalVars/nativeArrays passes (and their
> prerequisites) changed the earlier JS passes, making the #1–#11 Rust
> STALE (it was 565/0 at a point in time; each side is now deterministic
> but they differ on the flag forms). The re-verification needs a re-sync
> of the Rust twins against the worker's current estree.js — a dedicated
> pass when the pipeline settles. The #12 keep_variables port stays
> drafted (compiles). The #1–#11 wasm + the estree.js skip are restored
> clean.

> **Status 12 (2026-08-15): the worker's concurrent `liftLocalVars` +
> `nativeArrays` passes (commits 3f37bbf/c0b8531) inserted BETWEEN #11 and
> #12, churning the composition — the harness is now flaky (39–88
> mismatches varying run-to-run; the game diverges on the flag forms). The
> #1–#11 wasm was verified 565/0 at a POINT IN TIME; the worker's JS-side
> evolution may have made it stale. The #12 keep_variables port is DRAFTED
> (compiles; removed from the pipeline — its interaction with the worker's
> new passes needs the settled pipeline). Next session: re-verify the
> #1–#11 composition against the worker's CURRENT estree.js/lower.js (the
> diffs are the flag forms — the dropDeadFlags-family), then land #12.

> **Status 11 (2026-08-15): #1–#11 are DONE + verified — 565 files, 0
> mismatches.** `reclass_async_loops` (#11 — the whileLoopSync→whileLoop
> flip + the enclosing-function async marking) landed clean on the first
> try (the has_await_own non-descent + the post-order + the statement-level
> await wrap). The JS side's precompiledHead skip starts at #12
> (keepVariables). Next: #12 keepVariables (the store seeding + the repl
> mode), then #13 lowerNativeArrays (the Rust twin exists at the shir
> level — consolidation), then the lastExit family (#14-#17).

> **Status 10 (2026-08-15): #1–#10 are DONE + verified — 565 files, 0
> mismatches.** `direct_shell_fn_calls` (#10 — the dispatch→direct-call
> rewrite) landed: the fns map (async/hasReturn/posRefs), the unwrapWordList,
> the $?-emulation + positional-wrapper IIFEs (with the outer-await drop and
> the args-copy fix for the positional array). The JS side's precompiledHead
> skip starts at #11 (reclassAsyncLoops). Next: #11 reclassAsyncLoops
> (already drafted in spirit — the whileLoopSync→whileLoop flip — port it
> the same way).

> **Status 9 (2026-08-15): #1–#9 are DONE + verified — 565 files, 0
> mismatches.** The "3 divergences" were the mangled estree.js (the
> instrumentation churn broke the OLD side), NOT the port — a clean
> restore gave 0, and #9 return_in_loop landed on that baseline (also 0).
> The JS side's precompiledHead skip starts at #10 (directShellFnCalls).
> Next: #10 directShellFnCalls (the dispatch→direct-call rewrite — its
> positional wrapper is already proven in lower.js).

> **Status 8 (2026-08-15): the conservative env-fallback fallback was TRIED
> and REVERTED (49 mismatches — too broad; the JS unwraps most env-chain
> shapes). The exact 3-file condition remains open — the next session
> should compare the fired node's IDENTITY vs the post-#7 survivor (the
> clone hypothesis) or bisect the unwrap's per-file condition on the 3
> files. The #1–#8 milestone stands (562/565; the game + textures
> byte-identical). #9 return_in_loop is drafted + compiles (unwired).

> **Status 7 (2026-08-15): the unwrap divergence is ISOLATED + traced to the
> limit.** The JS's `unwrapStoreString` FIRES on the 3 files' `String(sh2.vars.X
> ?? …)` (the isStoreRead passes) and its `return unwrapStoreString(a)`
> yields the `??`-Logical (traced) — yet the post-#7 tree STILL carries the
> String(??). The fired node's parent is the `.toUpperCase` member's object;
> the rebuild should replace it. Hypothesis for the next session: the
> normalize's CLONE — the arrow becomes a fnExpr whose body is a clone while
> the fired String lives in a DISCARDED copy the unwrap visits, so the
> surviving clone never fires (the trace fires on the dead copy). Verify by
> comparing the fired node's identity vs the post-#7 node's identity. The
> pragmatic fallback: make my Rust unwrap MORE conservative (skip the
> unwrap when the ?? right-chain contains an env access — matching the
> observed JS behavior on these shapes), then land #9.

> **Status 6 (2026-08-15): the #1–#8 milestone stands with a KNOWN 3/565
> divergence + #9 drafted.** The earlier "565/0" was partially masked by a
> double-apply structure bug. The real state: `unwrap_store_string` (#7)
> diverges on 3 corpus files (063_hard_to_parse, 084_while_pipeline,
> dqs-nested-dollar): the JS's unwrap fires (traced) yet the rebuilt tree
> KEEPS the `String(sh2.vars.X ?? …)` (the JS rebuild's clone semantics);
> my Rust in-place replace removes it. The game + all textures stay
> byte-identical. `return_in_loop` (#9) is ported + compiles (removed from
> the pipeline — it is NOT the cause of the 3). Next session: replicate
> the JS rebuild's exact unwrap result (the fired node's parent must get
> the REBUILT ??-Logical, not the clone), then land #9.

> **Status 5 (2026-08-15): the #1–#8 head is DONE + verified — 565 files, 0
> mismatches.** The `FunctionDeclaration`/`FunctionExpression` model
> extension + `normalize_functions`/`unwrap_store_string`/`null_sentinel`
> landed (the two structural bugs — the param-loop nesting + the
> r.arrow-consumed-by-the-transform — fixed via the cast_done sibling
> check + the registration_arrows capture). The last "3 mismatches" were
> a regex-damaged estree.js (the OLD side), not the port — a clean
> restore gave 0. The JS side's precompiledHead skip now starts at #9
> (returnInLoop). Next: #9 returnInLoop + #10 directShellFnCalls (the
> walk-based bulk follows the same recipe).

> **Status 4 (2026-08-15): the #6–#8 attempt — the model extension LANDED, the
> port drafted + debugged, then restored to the verified #1–#5 state.**
> The `FunctionDeclaration` + `FunctionExpression` Stmt/Expr variants + all
> ~20 match arms were added and COMPILED (0 errors) — the model extension
> works (the unique-anchor method + the fn-scoped insertion). The
> `normalize_functions` port (`/tmp/estree-head-p2-drafted.rs`, ~700 lines:
> the walkers, the usage analysis, the param protocol, the `$var`
> interpolation, the function/adapter builder) was inserted + wired and
> produced 21/565 identity mismatches, debugged down to two structural bugs
> (the param loop nested the assignment check inside the CallExpression
> branch — fixed; the let-strip read `r.arrow` after the transform consumed
> it — the fix's structure repair corrupted the file). Restored the verified
> #1–#5 state (565 files, 0 mismatches; the wasm rebuilt).
> Next session: re-apply the two fixes on a clean copy + land the port
> (the let-strip must capture the arrows before the transform — do NOT
> move the step-4 block; capture `registration_arrows` instead).

> **Status 3 (2026-08-15): the #6–#8 attempt + the model-extension lesson.**
> `normalizeFunctions` (#6) needs a `FunctionDeclaration` Stmt variant —
> the estree.rs model only covers the wasm's emitted nodes. The variant +
> ~8 match arms were added and repeatedly corrupted by anchor-ambiguous
> splices (the same `{ declarations, kind }` arm text appears in several
> passes) — after restoring, the decision was to STOP the whack-a-mole:
> the port is **drafted in /tmp/estree-head-p2.rs** (the walkers, the
> usage analysis, the param protocol, the interpolate, the function
> builder) and the #1–#5 verified state is restored (565 files, 0
> mismatches; wasm rebuilt; game transpile ~1.5 s). The next session
> should add the variant + arms with UNIQUE anchors (or a dedicated
> `compile`-model), then land the drafted port.

> **Status 2 (2026-08-15): prefix now #1–#5.** Added `await_async_direct_calls`
> (the post-order visitor — the JS rebuild passes wrap bottom-up). The JS
> side's precompiledHead skip starts at #6 (normalizeFunctions). Harness:
> 565 files, 0 mismatches. Game transpile trending 2591 → 2399 → 1834 ms.
> Next: #6 normalizeFunctions (the ~250-line head — the biggest remaining
> block, ~450–650 ms), then #7 unwrapStoreString + #8 nullSentinel.

> **Status (2026-08-15): the first tranche is DONE + verified.**
> The wasm now exports `otranspilerl_compile(src, opts) → {"estree": …}`
> running the pipeline's first four passes in Rust (`compile_head_passes`:
> stripProcessEnv, awaitSyncFnCalls, forceAsyncFileRedirects,
> markAsyncOnAwait — the env ones use the default sh2runtime contract).
> `estreeToJsMapped` takes `precompiledHead` (skips the moved prefix;
> starts at #5 awaitAsyncDirectCalls); `bash2js` A1 uses the compile.
> **Differential harness: 565 corpus files + the game + all textures, 0
> mismatches** (compile + JS-suffix === the current full pipeline,
> byte-identical final JS). Game transpile 2591 → 2399 ms.
> The recipe for the remaining passes (#5–#24): port each into estree.rs,
> append it to `compile_head_passes` (the prefix order), extend the
> `precompiledHead` skip on the JS side, and the harness gates the
> byte-identity. The env-coupled #21/#23 stay JS-side until Phase 2's
> config lands.



### Phase 0 — oracles + the C-ABI (1–2 days)

- Freeze the identity oracles: the corpus + the game outputs, hashed (the
  methodology proven by the walk-table / merge-de-quad work: byte-identical
  generated JS per file).
- New wasm export: `otranspilerl_compile(src, opts_json) → { "js": …,
  "arrayVals": […] }` — the full pipeline + the codegen in one call. The
  options JSON carries `{ repl, knownArrays, env: {…} }` (Phase 2 fills the
  env object).
- Keep `otranspilerl_transpile` (the estree JSON) for the REPL/facade until
  Phase 3.
- Extend the C-ABI (wasi.rs) with the length-prefixed output envelope for the
  object return (or a two-call pattern: compile + compile_vals).

### Phase 1 — the 19 environment-agnostic passes + the codegen (2–3 weeks)

Port in dependency order, each twin **kept side-by-side with the JS original
until byte-identity is proven** (a Rust test transpiling the corpus with both
pipelines and comparing the final JS — the pass order is fixed, so the
comparison is end-to-end per file):

1. **Pipeline head** (4): `awaitSyncFnCalls`, `markAsyncOnAwait`,
   `awaitAsyncDirectCalls`, `normalizeFunctions` (the normalize-family
   composite; `stripProcessEnv` is Phase 2 — the Rust head takes the
   env-accessor config from the start so the pipeline order never forks).
2. **Store/coercion** (2): `unwrapStoreString`, `nullSentinel`.
3. **Loop/control** (2): `returnInLoop`, `reclassAsyncLoops`.
4. **Dispatch** (1): `directShellFnCalls`.
5. **Arrays/store** (2): `keepVariables` (the repl-mode + knownArrays from
   the opts), `lowerNativeArrays`.
6. **lastExit family** (4): `hoistLoopLastExit`, `hoistCommonLastExit`,
   `dropDeadFlags`, `pushLastExitToEnd` — adopt the JS semantics into the
   existing `hoist_last_exit`/`drop_dead_flags` Rust twins.
7. **Optimizations** (4): `mergeInitAssignments` (the de-quadratized form),
   `nativeForLoops`, `flattenAndOrAll`, `lowerPureFunctions`.
8. **The codegen** (the biggest single item, ~1 week): a Rust port of the
   astring precedence-aware emitter. Verify byte-identical JS vs astring on
   the corpus + the game before switching.

Gate: `otranspilerl_compile` output === the current `transpile` + JS-side
pipeline output, byte-for-byte, on all 546 corpus files + the game; the
sh2perl 293 tests + the game tests green.

### Phase 2 — the 4 environment-coupled passes, config-driven (3–5 days)

The env contract becomes the `env` field of the compile options:

- `env.devices`: the `/dev/*` namespace + the write/redirect semantics
  (`lowerDeviceRedirects` — a path list + the "fs.write" target shape).
- `env.fsBridge`: the redirect bridge rule (`forceAsyncFileRedirects` — which
  targets must go through the async `sh2.redirect`).
- `env.stdout`: the output target (`writeBuiltinOutput` — the stdout member
  shape).
- `env.envAccessor`: the env access (`stripProcessEnv` — `process.env` →
  `sh2.env`).

The **default config is exactly the current sh2runtime contract** → the
output stays byte-identical. The runtime's devices stay in JS (webgldev.js /
audiodev.js — the executor); only the AST-side adapters move. The passes are
parameterized Rust functions taking the config (a handful of knobs — not a
general plugin system).

Rationale for the config over "keep the 4 in JS": the 4 run *before* the
codegen, so keeping them JS-side would require the AST to cross back out for
the final 4 + re-enter for the codegen — the boundary cost returns. The 4 are
small and their config is tiny.

### Phase 3 — the callers (3–5 days)

- **bash2js A1** (the game): switch to `compile` — `src → { js, arrayVals }`.
  The shir-drop + the JS-side passes + JSON.parse all disappear; the
  arrayVals feed the store seeding as today.
- **debashcl fallback + bat2js**: their estrees come from *other* wasms —
  send the estree JSON to a `compile_from_estree(estree_json, opts)` twin of
  the export (the passes + codegen run in the wasm; the input is the estree
  JSON — the boundary is estree-in + JS-out). Alternatively keep the JS
  pipeline until debashcl retires — decide by the debashcl usage share.
- **The REPL (jtsh)**: uses `compile` with `repl: true` + the returned
  arrayVals; the genuinely stateful cross-line bits (the store routing
  against the live runtime) stay JS-side.
- **estreeToJsMapped**: shrinks to a thin wrapper over `compile` (the
  debashcl/bat/REPL paths) — the 19 agnostic passes + the codegen leave
  estree.js/lower.js.

## 4. Risks

- **The codegen port** — precedence rules + the emitter edge cases; the
  largest single risk (mitigated by the byte-identity oracle + keeping astring
  as the reference until the twin passes).
- **Pass-move correctness** — the identity oracle per phase; the corpus is the
  gate.
- **The debashcl/bat estree shapes** — the Rust passes must not assume the
  otranspilerl shapes (the existing Rust passes were written for the A1
  ingress; the debashcl estrees differ — test both).
- **The REPL's stateful interplay** — the live store seeding stays JS-side.
- **Iteration speed** — the wasm rebuild (~10 min) vs the JS edit cycle; the
  port keeps the JS passes as the reference until each twin is proven, so the
  worker's live-editing workflow is preserved.
- **Ownership** — estree.rs / shir.rs are the estree worker's single-owner
  files; this is a core-request-sized effort for that worker.

## 5. Timeline & the prize

~4 weeks of the estree worker's time (Phase 0: 2 days · Phase 1: 2–3 weeks ·
Phase 2: 3–5 days · Phase 3: 3–5 days).

The measured prize: game transpile ~2.6 s → **~1.2–1.5 s** (the passes at
Rust speed, no JSON.parse, one boundary crossing) — the estree JSON writer
stays for the `compile_from_estree` inputs (the debashcl/bat paths), and the
JS side keeps only the executor (the devices) + the REPL's stateful seeding.

> **Status 14 (2026-08-16): the mimecroft shader-fallback hunt.** The user's
> startup log showed `shaders: hand-written GLSL fallback (vertex: hand,
> fragment: hand)` + a black screen. Root causes, in order of severity:
> 1. **The game CRASHED before the first render** — `draw_char`'s loop-body
>    `return draw_rect(...)` was converted by `return_in_loop` (#9) into
>    `throw new sh2.ReturnSignal(...)`; the runtime's `whileLoopSync` catches
>    + rethrows it, but the DIRECT call generated by `directShellFnCalls`
>    (#10) did not catch it → the signal escaped to the top → crash at the
>    first menu frame. Fixed in BOTH the JS twin (`lower.js` — `canThrowReturn`
>    scan + a catch-return IIFE on the direct call) and the Rust twin
>    (`estree.rs` — same scan + `catch_return` in `mk_direct`); the wasm was
>    rebuilt. The game now runs to GAME DONE.
> 2. **The fallback trigger** — the emitters' per-stage state probes
>    (`vs_state=$(cat /dev/webgl/state)` + the `%FAILED*` pattern) switched
>    to the hand-written GLSL whenever the generated shader's compile FAILED
>    under the browser's ANGLE. Removed per the user's direction: the
>    vs_fb/fs_fb strings, the probes and the fallback writes are gone; the
>    bash-authored sh2glsl programs are the only path; the report always
>    prints `shaders: bash-authored (sh2glsl)`.
> 3. **Open: the shader WRITES don't land in this test env** — the emitted
>    `sh2.vars.glsl = String(await sh2.capture(...))` writes the STORE while
>    the follow-up test `sh2.test(\`"${glsl}"!=""\`)` reads the LIFTED module
>    `let glsl = ""` (the A1's typed lowering declared it; the assignment
>    lowered to the store member). The test is false → the write is skipped.
>    The shir's test_str_to_estree injects the bare Identifier for any
>    `is_lifted` name; the capture assignment path targets `sh2.vars.<name>`.
>    Fix candidates: (a) the capture assignment should also/only write the
>    lifted binding; (b) the injected Identifier should be a vars-member
>    read when the var is a module let. The worker's estree.js/shir.rs
>    single-owner territory — coordinate there.
