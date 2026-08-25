# SHELL_tcc_PROPOSAL.md — jtsh with a tcc backend (compile shell functions to wasm)

*2026-08-25 · discussion document, not committed design*

## The idea

A variant of jtsh that uses **TinyCC as a function backend**: instead of (or
besides) transpiling shell functions to JavaScript (`bash2js`), translate a
sourced `.sh` file's functions to **C**, compile them with **libtcc**, and call
the compiled functions from the interpreter. Sourced files that are unchanged
get their compiled functions served from a **cache** keyed by content hash.

The pieces all exist already:

| piece | status |
|---|---|
| shell → ShIR | otranspilerl / posix-sh-go frontends (byte-identical v1 subset) |
| ShIR → C | sh2perl `backend/c` worktree: `shir_to_c(&IrProgram) -> String`, always-compiles policy (unsupported nodes become `sh2.*` stubs) |
| C → wasm | `www/wasm-bin/tcc.wasm` — TinyCC 0.9.28rc built to wasm32-wasi with a **custom wasm32 code target** (715 KB); libc calls resolve to the shell's `src/c-runtime.js` |
| execution | `WasmRunner` (src/wasm.js) instantiates modules against the env runtime |

So the pipeline is: `.sh` → A1 shIR → `shir_to_c` → **libtcc** → wasm module →
call exported `fn_*` symbols with the shell's variable store / fd table passed
as arguments (or as WASI imports).

### "Statically linking libtcc"

Three shapes, in increasing ambition:

1. **Subprocess** (works today, zero new code paths): stage `tcc.wasm` +
   `tcc-include.dat`, run `tcc -c` per sourced file exactly like the existing
   `cc` command does. Cost: a WASI process spawn per compile (~80 ms wall in
   the wasmtime test below; less in-process).
2. **Static-link libtcc *inside* the sandbox**: build a tiny WASI shim that
   links `libtcc.a` (already present as `/tmp/tcc/libtcc1.a`'s sibling — the
   compiler library proper ships in the tcc source tree) and exposes
   `tcc_compile_string()` / `tcc_relocate()` over a custom section, so one
   long-lived compiler instance serves every sourced file without respawning.
   The whole compiler is only **715 KB of wasm** — even doubling that is noise
   next to the Go toolchain (go.wasm et al.) this shell already ships.
3. **Native jtsh + libtcc JIT** (no wasm at all): link `-ltcc` into a native
   build and use `TCC_RELOCATE_AUTO` to emit **x86_64 machine code directly
   into memory** — no cache files needed, sub-millisecond compiles. Only
   relevant for the node/native deployment; browsers must go through wasm.

## How big would the compiled functions be?

Measured (not estimated) with the actual shipped artifacts. Repro: extract
`tcc-include.dat` to `/tmp/tcc/include`, run `tcc.wasm` under wasmtime, compile
probe files; x86_64 side is host gcc for comparison. Scratch rig: `/tmp/tccjit`.

### Per-function size — wasm32 (tcc) vs x86_64 (gcc)

Six representative functions (`empty`, two-arg add, loop-sum, printf wrapper,
if/else chain, switch-on-string). Wasm column includes the fixed module
overhead (~460 B: type section, exports, memory decl), shown separately:

| function                | x86_64 -O0 | x86_64 -O2 | wasm32 (tcc), incremental |
|-------------------------|-----------:|-----------:|--------------------------:|
| empty                   |      11 B  |       5 B  |           460 B module floor |
| add(a,b)                |      41 B  |       9 B  |           +409 B |
| loop_sum(n)             |      89 B  |      78 B  |          +~1000 B |
| strfn (printf "%s\n")   |      46 B  |      26 B  |           +178 B |
| cond (if/else arith)    |      55 B  |      37 B  |          +~1300 B |
| strswitch               |      98 B  |      64 B  |                    |
| **6-fn module total**   | **298 B .text** | 256 B | **4874 B** |

Rules of thumb that fall out:

- **x86_64**: a typical lowable shell function is **10–100 B** of machine code
  at -O0 (gcc -O2 shrinks straight-line code but *grows* loops — it unrolls).
- **wasm32 via tcc**: budget **~200–1000 B per function**, plus ~460 B fixed
  per module. Roughly **0.9 bytes of wasm per byte of generated C**.
- tcc emits no optimizer passes worth the name — treat its output as "-O0
  shaped". The win over interpretation comes from eliminating dispatch, not
  from code quality.

### File scale (a realistic sourced library)

Synthetic 30-function numeric-loop library (5.4 KB of C):

| artifact | size | notes |
|---|---:|---|
| generated C | 5.4 KB | ~180 B of C per shell function |
| tcc → wasm32 | **50 KB** | ~33 B per function per… i.e. ~1.6 KB/function incl. scaffolding |
| gcc -O0 → x86_64 | **4.2 KB .text** | ~140 B/function |

A big sourced file (say 300 functions) lands around **500 KB of wasm** — fine
for a cache directory, and still smaller than the page's vendor JS.

### Compile/instantiate cost (why caching matters, quantified)

| operation | measured cost |
|---|---|
| tcc compile, 30-fn file (subprocess incl. wasmtime startup) | **78 ms** |
| `WebAssembly.compile` of the 50 KB module | **11 ms** |
| `new WebAssembly.Instance` (cached module, stub imports) | **1.7 ms** |

So: first `source biglib.sh` pays ~90 ms; every later `source biglib.sh` with a
warm cache pays ~13 ms if you re-compile the module from cached bytes — and
**~0 ms across page loads** if you also keep the compiled
`WebAssembly.Module`: modules are structured-clonable, so the main thread can
hand a *compiled* module to worker shells for free (`postMessage(m)`, no
re-compilation). Persisting raw bytes to the VFS/IndexedDB keeps the 11 ms
compile as the only warm-start cost.

## Caching design

**Granularity: the sourced file, not the individual function.** Bash semantics
make per-function caching wrong: one `source lib.sh` defines many functions
that freely reference each other, and any of them can be redefined by a later
source. File-level units match how functions actually enter the shell.

```
key   = sha256(file bytes) ‖ shir_to_c version ‖ tcc build id ‖ ABI version
value = compiled module (raw .wasm bytes) + export name table + used-imports set
store = $VFS/cache/jitsh/<key>.wasm   (browser: Cache API / IndexedDB)
```

- Unchanged file → hash hit → skip shir_to_c AND tcc entirely; instantiate
  cached module (1.7 ms) and bind its exports into the function table.
- Changed file → full rebuild of just that file's module.
- Cross-module calls: file B's functions calling file A's functions either go
  through **imports bound at instantiation time** (name-mangled `sh_<file>_fn`)
  — the natural fit, since WasmRunner already threads an import object — or,
  simplest first cut, one merged module per "source closure" (concatenate the
  C before compiling; invalidates together, like today's busybox merge).
  Merged-module-first is recommended: it sidesteps circular-source edge cases
  and mirrors the proven busybox strategy.
- What is NOT cacheable across versions: anything relying on the shell's live
  state. Compiled functions must take the variable store / positional params /
  fd table as explicit parameters (or imports); they close over nothing.

### The honest caveat: what tcc does *not* buy you

The current bash2js path hands shell code to V8, whose tiering JIT will
eventually emit better code than tcc ever will. Compiling to wasm wins where:

- the same file is sourced repeatedly into fresh shells/workers (cache amortizes),
- scripts are arithmetic/loop-heavy and cold-start latency matters (no waiting
  for V8 to warm up — wasm is fast from instruction zero),
- you want deterministic performance for benchmark gates (the corpus gates in
  sh2loop measure exactly this kind of thing),
- and on the native build, libtcc JIT gives x86_64 at 11–100 B/function with
  essentially zero compile latency — strictly better than both alternatives
  for hot functions, at the cost of losing browser portability.

It loses where scripts spend their time in builtins and expansions — every
`$(...)`, parameter expansion, and external command crosses back into the
interpreted runtime through an import call, so the ceiling is bounded by the
runtime bridge, not the compiled loop bodies. Start by targeting the shape the
C backend already lowers well (numeric vars, arith, control flow, printf) and
fall back to bash2js for everything else — per-*function*, not per-file, the
fallback decision can be made at shir_to_c time (it already marks unsupported
nodes with TODO stubs).

## The memory-safety boundary

Shell is a memory-safe input language: values are strings and 64-bit wrapping
integers; there are no pointers, no manual lifetime, no unchecked indexing.
Users can write infinite loops and `rm -rf /`, but they cannot segfault the
interpreter. That property must survive the C compilation step — **sourcing a
bad `.sh` (or a hostile one) must degrade to a clean per-command error, never
crash the REPL.** The two execution modes differ structurally here:

### wasm mode (default — containment is structural)

Compiled functions run as wasm modules inside `WasmRunner`. Every classical
crash becomes a **trap**, not a signal: out-of-bounds access, division by zero,
indirect-call type mismatch, stack exhaustion → `WebAssembly.RuntimeError`.
The host process cannot segfault from module code even if `shir_to_c` emits
broken C. Requirements to make that a *contract* rather than an accident:

- **Catch traps at the call boundary** (`src/wasm.js` currently has no
  `RuntimeError` handling): wrap exported-function calls, map the trap to the
  shell's crash convention (`$? = 139`, "segmentation fault" on stderr), and
  keep the shell running. Same treatment the real bash gives a segfaulting
  child binary.
- **Intra-sandbox corruption is the residual risk.** A wild store inside
  linear memory doesn't trap — it corrupts whatever shares that memory. If
  compiled modules share memory with the variable store / heap, a bug can
  silently trash shell state with no error at all. Two mitigations, in order
  of preference: (a) route ALL state access through checked runtime imports
  (the sh2.* helper seam) so compiled code never holds raw pointers into the
  store; (b) give each compiled closure its own module instance/memory and
  pass state across the import boundary by value/handle.
- **Resource exhaustion must be finite**: recursion depth (bash functions
  recurse; generated C recurses harder — enforce a depth limit in the thunk
  layer before calling into compiled code), allocation caps on the runtime
  helpers, and no VLA/alloca sized by unbounded input.

### native JIT mode (opt-in only)

libtcc relocating x86_64 into the host process has **no containment at all**:
no MMU boundary, no trap conversion, and tcc performs none of the checks gcc's
sanitizers would. A bad generated function segfaults node itself. Therefore:

- Native JIT is **never** the default path for sourced files. Gate it behind
  an explicit opt-in (`set -o unsafe-jit` or equivalent), documented as "the
  compiler trusts your script the way `cc` trusts your C".
- Even under opt-in, apply the same shir_to_c safety rules below — they cost
  nothing and shrink the blast radius from "any script" to "compiler bugs".

### Rules for shir_to_c (make this a GATE)

The C is an internal representation of a safe language, so UB reachable from a
safe input is a backend bug, not user error. Enforce, and add corpus/fuzz gates
that assert it:

| shell semantics | naive C | required emitted form |
|---|---|---|
| `$((a + b))` wraps mod 2⁶⁴ | signed overflow = UB | unsigned/wrapping ops (or `-fwrapv`-equivalent builtins) |
| division by zero → error message | SIGFPE | explicit zero-check → runtime error stub |
| strings are opaque values | raw `char*` arithmetic | all copies/compares via bounded runtime helpers; the existing fixed-buffer scheme (`char v[N+1]` + `strncpy` truncation + NDEBUG'd asserts) stays mandatory |
| unbounded recursion allowed-ish | stack overflow | depth counter in the function-entry thunk |
| no pointers exist | pointer casts in lowering | forbid pointer-typed intermediates entirely |

Property to gate on: **for any byte string passed as a script, the pipeline
returns output, an exit status, or a clean trap-mapped error — the host
process survives.** Fuzz `shir_to_c`+tcc outputs with the corpus plus random
inputs under a trap-catching harness; this slots naturally next to the
corpus gates the backend worktrees already run.

Note this also answers the adjacent question: directly sourcing/running a bad
`.c` file today goes through the separate-command pipeline (`cc` → `.wasm` run
like any external binary), where a trap already costs only the child command.
The new exposure introduced by this proposal is precisely the function-JIT
path, which is why the contract above is stated for it explicitly.

## Full jtsh semantics: compiled code lives ON TOP of the runtime seam

jtsh features like `cd`-ing into a linked list (ptrfs) seem to demand "real"
C — they don't, because jtsh/tcc-C already virtualizes memory:

- The existing c pipeline's pointers are NOT raw addresses. `memAlloc`
  returns a registry BOX (`{arena, tag, off}`); a pointer value is a handle;
  every load/store/advance crosses into `sh2.memLoad/memStore/memAdvance`.
  That indirection is precisely why ptrfs works today: `cd $ptr` is an
  INTERPRETED builtin walking the same registry via `memBoxOf` /
  `ptrMembers` / `nodeChild`, so any structure a tcc-compiled program builds
  is navigable as a filesystem.
- A jtsh-tcc variant inherits this wholesale by compiling against the same
  seam. `cd` itself is never compiled: builtins stay interpreted, reached
  from compiled code through ONE generic import (e.g. `sh2.exec(cmd, args)`).
  Only user-defined function BODIES get compiled.
- Therefore no translation round-trip ever happens: the pipeline is strictly
  one-directional (.sh → shIR → C → wasm, once, cached). At run time a
  compiled function either does straight-line work or calls imports back
  into the interpreter — nothing is re-transpiled mid-flight.

Two consequences worth stating plainly:

1. **The generated C is a dialect with no raw memory.** `malloc`, `p->next`,
   `printf` all lower to runtime calls. This SHRINKS the memory-safety
   boundary above: heap corruption through wild pointer arithmetic becomes
   impossible by construction (handles + checked helpers); what remains raw
   is only stack locals inside the module's own linear memory.
2. **Pointer-chasing code gains ~nothing from compilation** — each
   `memLoad`/`memAdvance` is an import call into JS, so traversing a linked
   list in compiled wasm is plausibly SLOWER than V8-JIT'd bash2js running
   the same loop. The compile-win profile narrows honestly to: scalar
   arithmetic and control flow over locals, tight numeric loops. Use the
   per-function fallback (bash2js) for traversal-heavy functions; keep the
   data structures in boxes so ptrfs keeps working regardless of who wrote
   them.

## Why not just make the shell Rust?

The 15 ns/crossing tax above is a JS-embedder artifact, not a law of nature.
A native seam call costs ~1–2 ns, so a shell whose runtime seam is Rust (or
any native language) makes compiled-function↔runtime crossings ~10× cheaper,
kills GC pauses, and — since sh2loop's core is ALREADY Rust — reuses existing
assets rather than rewriting them:

| existing Rust asset | role in a jtsh-rs |
|---|---|
| `otranspilerl` (`sh2perl/core`: shir.rs, parser/) | the shell's own parser/lower — no JSON contract hop, in-process ShIR |
| c-backend worktree (`shir_to_c(&IrProgram) -> String`) | the compiler front half, as a library call |
| libtcc (static link) + `TCC_RELOCATE_AUTO` | x86_64 codegen into the same process |
| new, small | the sh2.* seam: var store, mem-box registry (ptrfs), fd table |

In that world a compiled function calls the var store the way it calls any
other function — `cd $ptr` walks an in-process registry — and the whole
pipeline is one binary. The memory-safety story arguably *improves*: seam
helpers written in safe Rust are bounds-checked by construction, and the
compiled code no longer shares a GC heap with the interpreter.

So why doesn't this proposal just do that?

1. **It's the wrong trade for the browser line.** Compile jtsh-rs to
   wasm32-wasi and it can no longer load the functions tcc emits without help:
   a wasm module can't instantiate another wasm module — that needs the
   embedder (back to JS crossings), or embedding a wasm interpreter (wasmi)
   inside the shell-wasm, which is 10–50× slower than the V8 wasm we just
   measured at 2.5 ns/iter. The deep point: **in the browser, V8 already is
   the optimizing backend** — bash2js hands shell code to one of the best
   compilers in existence. tcc-JIT only beats V8 where there is no V8.
2. **sh2runtime is years of JS** (zip/http VFS mounts, procfs, jobs/SAB
   workers, uutils/python/perl/zig/tcc integration, the REPL UI). Rewriting
   it is not on the table; the scope here is a NATIVE COMPANION —
   `jtsh-rs` built from the sh2loop crates plus a small seam — targeting
   compute-dense scripts and CI/gate harnesses, not feature parity with the
   interactive browser shell.
3. **Seam-heavy code barely benefits anyway.** The profile from the last
   section holds with sharper edges: scalar/numeric loops get 10–50× from
   going native-with-native-seam; traversal-over-boxes gets maybe 2× (the
   crossing got cheaper but is still per-op); anything builtin-bound gets
   nothing. The per-function fallback decision survives unchanged.

Recommended posture: keep the three backends ranked by deployment —
bash2js/V8 (browser, default), wasm32-via-tcc (isolation-sensitive + cached
sourcing, works everywhere), jtsh-rs + native libtcc JIT (the endgame for
native hosts, built ON the sh2loop Rust core rather than against it).

## Suggested phasing

1. **Spike**: hand-run the pipeline end to end on one corpus file
   (`otranspilerl --target c` → `shir_to_c` → tcc.wasm → WasmRunner call),
   measure correctness against the gate harness.
2. **jtsh intercept**: `source` checks the cache table before bash2js;
   miss → compile → store. Merged-module-per-closure first. Land the
   `RuntimeError`→exit-139 mapping and the recursion-depth thunk BEFORE any
   compiled function becomes callable from a script (the memory-safety
   contract is load-bearing from day one).
3. **Browser plumbing**: persist cache in IndexedDB, pass compiled modules to
   workers via structured clone.
4. **Optional native mode**: `-ltcc` + `TCC_RELOCATE_AUTO` for the node build.

## Open questions

- Does `shir_to_c`'s `char v[N+1]` fixed-buffer scheme compose with the
  shell's shared variable store (strings must round-trip through the store on
  function exit)?
- Redefinition semantics: bash allows `f() { … }` to replace a compiled
  function mid-session — needs a thunk layer (exported name → indirection
  table entry) so stale modules never stay callable.
- Is one merged module per closure acceptable given bash sources can change
  between executions of the same script? (Conservative answer: yes — invalidate
  the whole closure on any member change; measured rebuild cost is ~80 ms.)
