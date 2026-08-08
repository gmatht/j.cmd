# BUILD_ISSUES — bash-wasm (bash 5.3 → emscripten wasm)

What it took to get `bash-wasm/` building on this machine (emscripten
6.0.6 from `/root/src/emsdk`), and the three separate failure modes that
had to be fixed before a working `bash.wasm` could land in
`www/wasm-bin/`.

Build context:

- project: `bash-wasm/` (bahamas10/bash-wasm, bash 5.3 release tarball)
- target: `emcc` → wasm32-unknown-emscripten, MODULARIZE glue
- emscripten: 6.0.6 (upstream built with 5.0.4 — version drift is the
  root cause of most of this)
- host: x86_64 Linux, 16 cores

---

## 1. Poisoned configure cache → native (gcc) build instead of wasm

### Symptom

`bash-wasm/build/Makefile` had `CC = gcc`; every `.o` was
`ELF 64-bit LSB relocatable, x86-64` instead of wasm. A previous
session's `make` had compiled the whole tree as a *native* bash and
stopped before the link, so it looked half-built but was entirely
wrong.

### Root cause

`emconfigure` sets `CC=emcc` on the configure command line, but the
committed `cache.txt` (passed via `--cache-file=../cache.txt`) already
contained:

```
ac_cv_prog_ac_ct_CC=${ac_cv_prog_ac_ct_CC=gcc}
ac_cv_prog_CPP=${ac_cv_prog_CPP='gcc -E'}
```

The cache is sourced by configure and short-circuits the compiler
probe, so `ac_ct_CC`/`CPP` came back as gcc regardless of the
environment. The cached `ac_cv_prog_ac_ct_CC=gcc` likely leaked in from
an earlier native configure run.

### Fix

Delete the cache and reconfigure through emconfigure:

```bash
cd bash-wasm
rm -rf build cache.txt
mkdir -p build && cd build
emconfigure ../bash-5.3/configure \
  --build="$(bash ../bash-5.3/support/config.guess)" \
  --host wasm32-unknown-emscripten \
  --cache-file=../cache.txt --without-bash-malloc
```

After this, the Makefile correctly shows
`CC = /root/src/emsdk/upstream/emscripten/emcc`.

---

## 2. `sigsuspend` missing from emscripten libc → bash miscompiles

### Symptom

Compilation died almost immediately:

```
../bash-5.3/execute_cmd.c:2173:3: error: assigning to 'sigset_t'
    (aka 'struct __sigset_t') from incompatible type 'int'
 2173 |   BLOCK_SIGNAL (SIGCHLD, set, oset);
../bash-5.3/sig.h:65:36: note: expanded from macro 'sigemptyset'
#  define sigemptyset(set) (*(set) = 0)
```

plus a lurking `conflicting types for 'sigprocmask'` in `sig.c` (bash's
non-POSIX fallback defines `sigprocmask(int, int*, int*)`, emscripten's
signal.h declares `sigprocmask(int, const sigset_t*, sigset_t*)`).

### Root cause

Two facts collide:

1. Emscripten's musl libc models `sigset_t` as a real struct
   (`struct __sigset_t`) with proper `sigemptyset`/`sigaddset`/
   `sigprocmask`/`sigaction` functions.
2. bash's configure decides the "signal vintage" with a **link test**
   that calls `sigsuspend()`:

   ```c
   sigset_t ss;
   struct sigaction sa;
   sigemptyset(&ss); sigsuspend(&ss);
   sigaction(SIGINT, &sa, 0);
   sigprocmask(SIG_BLOCK, &ss, 0);
   ```

   Emscripten **6.0.6 does not ship `sigsuspend`** in
   `sysroot/lib/wasm32-emscripten/libc.a`:

   ```
   wasm-ld: error: .../conftest.o: undefined symbol: sigsuspend
   ```

   (Upstream emscripten 5.0.4 did implement it, which is why the
   upstream repo "just worked".)

The link test fails → `bash_cv_posix_signals=no` →
`bash_cv_signal_vintage=v7` → `config.h` has `/* #undef HAVE_POSIX_SIGNALS */`
→ bash switches to its legacy non-POSIX path where `sigset_t` is assumed
to be an `int` (bitmask macros `sigemptyset(set) (*(set) = 0)` etc.) →
immediate type errors against emscripten's struct `sigset_t`.

### Fix

Force the POSIX vintage, exactly as upstream's committed `cache.txt`
did:

```bash
# cache.txt — restore the two upstream values
bash_cv_posix_signals=${bash_cv_posix_signals=yes}
bash_cv_signal_vintage=${bash_cv_signal_vintage=posix}
```

Re-run `emconfigure` (above) so `config.h` regenerates with:

```
#define HAVE_POSIX_SIGNALS 1
```

With POSIX signals defined, bash compiles its struct-`sigset_t` paths
and only calls functions emscripten *does* implement
(`sigemptyset`, `sigaddset`, `sigdelset`, `sigfillset`, `sigismember`,
`sigprocmask`, `sigaction` (weak), `signal`, `raise`, `kill`, `killpg`,
`waitpid`). `sigsuspend` is never referenced by bash itself — it only
appeared in configure's probe — so the missing symbol never matters
again. (JOB_CONTROL stays off; `nojobs.c` is self-contained.)

---

## 3. Glue is CommonJS, project is `"type": "module"`

### Symptom

After a successful build, `www/vendor/bash.js` loaded fine in the
`bash-wasm/web/` demo (classic `<script>` tag) but was unusable from
the main project:

- `require()`ing it from node returned `{}` instead of the factory
- `import()...default` was `undefined`

### Root cause

The default emscripten MODULARIZE glue ends with a UMD export:

```js
if (typeof exports === 'object' && typeof module === 'object') {
  module.exports = createBashModule;
} else if (typeof define === 'function' && define['amd'])
  define([], () => createBashModule);
```

`/root/src/sh2runtime/package.json` sets `"type": "module"`, so node
treats `www/vendor/bash.js` as an ES module: no `module`/`exports`
exist, no export branch runs, and `createBashModule` stays private.
(Byte-identical glue at a path *outside* the package, e.g. `build/bash`,
`require()`d fine — which made this confusing to debug.)

### Fix

Rebuild the link with ESM output, matching the nethack precedent
(`www/vendor/nethack.js` is also `export default` and is loaded via
`(await import(GLUE_URL)).default` in `src/nethack.js`):

```bash
emmake make bash -j1 LDFLAGS='-sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sMODULARIZE=1 \
  -sEXPORT_NAME=createBashModule -sEXPORT_ES6=1'
```

(`EXPORT_NAME` is ignored when `EXPORT_ES6=1`; the loader takes the
default export.)

---

## The working build (one process, no system overload)

```bash
cd bash-wasm
rm -rf build cache.txt
mkdir -p build && cd build

# 1. configure (emscripten compiler, posix signal vintage from cache)
emconfigure ../bash-5.3/configure \
  --build="$(bash ../bash-5.3/support/config.guess)" \
  --host wasm32-unknown-emscripten \
  --cache-file=../cache.txt --without-bash-malloc

# 2. build with ONE process (-j1) so the system isn't overloaded
emmake make bash -j1 LDFLAGS='-sFORCE_FILESYSTEM=1 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain -sMODULARIZE=1 \
  -sEXPORT_NAME=createBashModule -sEXPORT_ES6=1'
```

Outputs:

- `build/bash` — ESM glue (factory `createBashModule`, default export)
- `build/bash.wasm` — ~1.3 MB wasm

The `web/` demo works as-is: `web/bash.js` / `web/bash.wasm` are
symlinks into `../build/`.

## Install into the project

```bash
cp bash-wasm/build/bash.wasm www/wasm-bin/bash.wasm   # project bin
cp bash-wasm/build/bash      www/vendor/bash.js        # ESM glue
```

`www/wasm-bin/*.wasm` is git-whitelisted (`.gitignore`),
`www/vendor/` is committed normally.

Loader pattern (same as `src/nethack.js`):

```js
const GLUE_URL = new URL("../www/vendor/bash.js", import.meta.url).href;
const factory = (await import(GLUE_URL)).default;
const bash = await factory({
  noInitialRun: true,
  locateFile: (p) => new URL("../www/wasm-bin/" + p, import.meta.url).href,
  print: (t) => { /* stdout */ },
  printErr: (t) => { /* stderr */ },
});
bash.FS.writeFile("/script.sh", source + "\n");
bash.callMain(["/script.sh"]);
```

`locateFile` is required because the wasm lives in `wasm-bin/`, not next
to the glue (default lookup would be `www/vendor/bash.wasm`).

## Verification

```bash
node - <<'EOF'
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const createBashModule = require("./bash-wasm/build/bash"); // CJS build only
const m = await createBashModule({ noInitialRun: true, print: console.log });
m.FS.writeFile("/s", 'echo "bash $BASH_VERSION on $MACHTYPE"\n');
m.callMain(["/s"]);
EOF
```

Expected: `bash 5.3.0(1)-release on wasm32-unknown-emscripten` and a
working `$RANDOM`/`$SRANDOM` (getrandom is wired through).

## Known limitations (expected, not bugs)

- **Unsupported syscalls** warn on stderr at runtime:
  `__syscall_getresgid32`, `__syscall_wait4` — no real fork/wait or
  uid/gid model in the browser sandbox. `$?`/exit codes still work via
  emscripten's exit handling.
- **No job control**: `JOB_CONTROL` is off (no termios/fork), bash
  uses `nojobs.c`.
- **No external processes**: `echo "x" | grep y` can't spawn a real
  grep inside bash; external commands only work through the harness.
- **Emscripten version sensitivity**: upstream built with emscripten
  5.0.4. If the sysroot gains/loses a libc symbol that bash's configure
  probes, re-check `bash_cv_signal_vintage` in `cache.txt`.

---

# zsh (git master, "5.9.999.3-test") and fish (3.7.1) → wasm

Same target as bash (emscripten 6.0.6, MODULARIZE + EXPORT_ES6 glue in
`www/vendor/`, wasm in `www/wasm-bin/`). Two more shells, three more
failure modes — plus one deliberate version choice.

## Why fish 3.7.1 and not fish 4

fish 4.x is the **full Rust rewrite**. Its crate set is a wasm wall:

- `nix = 0.29` with `inotify`/`event`/`resource`/`fs` features —
  `inotify` has no wasm support at all;
- direct `libc::fork()` / `tcsetpgrp()` / `getpgrp()` in
  `src/exec.rs`, `src/proc.rs` — process control wasm cannot provide
  (emscripten `fork` is a `-1` stub; Rust std on
  `wasm32-unknown-emscripten` is Tier 2 with gaps);
- `pcre2` git dep + `terminfo` crate — no ready wasm builds.

No browser port of fish 4 exists. The one that does (szhu's
fish-shell-browser demo) is built from the 3.x C++ tree, which is what
emcc + our wasm ncurses integrate with directly. Same core value
(real fish syntax/scripting) for a fraction of the porting cost.

## 4. zsh: missing `configure` script

### Symptom

The git tree ships only `configure.ac`; `./configure` didn't exist.

### Fix

```bash
cd build/zsh-wasm/src
autoconf      # configure.ac → configure
autoheader    # generates the missing config.h.in
```

## 5. zsh: `setresuid`/`setresgid` declared but hidden

### Symptom

```
options.c:780:6: error: call to undeclared function 'setresgid'
```

### Root cause

Emscripten's `unistd.h` declares them only under `#ifdef _GNU_SOURCE`,
but configure's *link* test passes anyway (the symbols exist in libc
as no-op stubs) → zsh believes they're usable.

### Fix

Compile with `-D_GNU_SOURCE` so the declarations match the probe:

```
CFLAGS="-g -O2 -D_GNU_SOURCE"
```

## 6. zsh: `sigsuspend` missing again — but as a real caller

### Symptom

```
wasm-ld: error: signals.o: undefined symbol: sigsuspend
```

Unlike bash (which only had it in configure's probe), **zsh actually
calls** `sigsuspend()` — `signal_suspend()` in `Src/signals.c`, used by
the `wait` paths in `jobs.c`.

### Fix

A 12-line stub (see `build/zsh-wasm/build/Src/sigsuspend-stub.c`):
mimic "interrupted" (`errno = EINTR; return -1`). Wait loops make
progress and `kill(pid, 0)` probes still terminate them; there are no
real signals or children in wasm anyway. Injected into the link without
touching the Makefile:

```bash
emmake make -j1 zsh EXTRAZSHOBJS=Src/sigsuspend-stub.o LDFLAGS="$EMFLAGS"
```

(the `zsh` target lives in `Src/`, not the top-level Makefile).

zsh also needed a terminal library — see the shared note below.

## 7. fish + zsh: no terminal library on the target

### Symptom

zsh's configure **hard-fails** without `tgetent` ("No terminal handling
library was found"). fish's CMake `find_package(Curses)` is REQUIRED.
Emscripten's sysroot ships neither.

### Fix (two parts)

- **zsh**: reuse bash's bundled wasm termcap
  (`bash-wasm/build/lib/termcap/libtermcap.a`) via
  `--with-term-lib=termcap` + `-L`/`-I` to it. bash's termcap provides
  `tgetent/tgetstr/tgetnum/tgetflag/tgoto/tputs`.
- **fish**: fish needs terminfo-style functions (`setupterm`,
  `tigetflag`, `tparm`, `tputs`) that termcap lacks — so build real
  **ncurses 6.5 for wasm**:

  ```bash
  emconfigure ../configure --host=wasm32-unknown-emscripten \
    --without-ada --without-cxx --without-cxx-binding \
    --without-manpages --without-progs --without-tests \
    --without-debug --without-shared \
    --with-fallbacks="xterm-256color dumb"   # ← key
  ```

  `--with-fallbacks` compiles the terminfo entries *into the library*
  (generated at configure time by the host `infocmp`), so
  `setupterm("xterm-256color")` succeeds with no external terminfo DB
  — and fish gets real colours/keys, not stubs.

## 8. fish: `__fallthrough__` macro collides with libc++

### Symptom

```
__functional/hash.h:70:9: error: expected ']'
   70 |       [[__fallthrough__]];
```

### Root cause

fish's `config_cmake.h.in` defines the **reserved identifier**
`__fallthrough__` as `__attribute__((fallthrough));`. libc++ (the
emscripten sysroot's C++ stdlib) uses the same token as
`[[__fallthrough__]]` — the macro mangles it into
`[[__attribute__((fallthrough));]]` and parsing explodes. (On Linux
fish normally links libstdc++, which doesn't use that token, so it
never bites.)

### Fix

Patch `config_cmake.h.in` to define `__fallthrough__` as empty:

```c
#define __fallthrough__
```

Verified that libc++'s `[[__fallthrough__]]` still parses with the
empty macro (empty attribute lists are valid); fish's bare
`__fallthrough__;` statements become empty statements.

## fish build recipe (CMake)

```bash
NCDIR=build/ncurses-wasm/ncurses-6.5/build
emcmake cmake ../fish-3.7.1 \
  -DCURSES_INCLUDE_PATH=$NCDIR/include \
  -DCURSES_LIBRARY=$NCDIR/lib/libncursesw.a \
  -DCURSES_CURSES_LIBRARY=$NCDIR/lib/libncursesw.a \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXE_LINKER_FLAGS="$EMFLAGS"
emmake make -j1
```

fish's CMake also builds `fish_indent`, `fish_key_reader`,
`fish_test_helper` — only `fish` (the shell) is deployed.

## Install

```bash
cp build/zsh-wasm/build/Src/zsh      www/vendor/zsh.js
cp build/zsh-wasm/build/Src/zsh.wasm www/wasm-bin/zsh.wasm
cp build/fish-wasm/build/fish.js     www/vendor/fish.js
cp build/fish-wasm/build/fish.wasm   www/wasm-bin/fish.wasm
```

Same loader pattern as bash (`(await import(GLUE)).default` +
`locateFile` → `wasm-bin/`). zsh runs `zsh script.zsh`; fish runs
`fish script.fish` (or `fish -c 'cmd'`).

## Verified

- zsh 5.9.999.3-test: `print`, arithmetic `$((x+1))`, arrays
  `$arr[2]`, `for` loops, functions — PASS
- fish 3.7.1: `echo`, `math`, arrays `$arr[2]`, `for` loops, functions
  with `$argv` — PASS, and notably **zero** unsupported-syscall warnings
- both load from the installed `www/` layout via `import().default` +
  `locateFile("../www/wasm-bin/…")`

---

# The otranspiler web GUI (www/otranspiler.html)

The old debashc webgui (`debashc/www/index.html`, Rust-wasm `pkg/debashl.js`)
moved to the new engine: `www/otranspiler.html` + `www/otranspiler-examples.js`,
driven by the unified pipeline (sh → A1 via the debashl core; zsh/fish/go/py/
c/pl → A1 via the merged frontend; A1 → any of the nine renderers via
`otranspilerl.wasm`).

## The busybox frontend artifact (9th wasm build in wasm-bin/)

Non-sh sources need the seven Go frontends. The shell command builds them on
first use (`go build`, ~30 s + 50 MB toolchain); the web GUI ships the
result prebuilt instead:

- `src/busybox.js` — shared merge+build module (extracted from the shell
  command): fuses the seven frontends + shir-emit-go + the dispatcher into
  ONE stdlib-only `main.go` (identifier-prefixed to avoid collisions), and
  either stages the prebuilt wasm or builds on first use.
- `www/wasm-bin/otranspiler-busybox.wasm` (7.3 MB) — built HERE with the
  real go toolchain, regenerated by `./build-wasm-busybox.sh` whenever the
  vendored frontends change.

## Runtime matrix for the stdout diff

| target | runtime | diff works? |
|---|---|---|
| js | sh2 runtime (src/sh2runtime.js) | ✅ identical stdout |
| sh | bash.wasm | ✅ (sh→sh roundtrip) |
| zsh / fish | zsh.wasm / fish.wasm (this session's builds) | ✅ as SOURCE; not targets (otranspilerl renders js/pl/c/go/py/sh/java/rs/zig/shir only) |
| c | tcc.wasm → wasm → WasmRunner | ✅ |
| go | go.wasm toolchain (GoRunner) | ✅ (slow first run) |
| py | micropython.wasm | ⚠ generated code targets CPython (f-strings, os/subprocess) — old micropython build often rejects it |
| pl | zeroperl.wasm | ⚠ subset — some core modules missing |
| java / rs / zig | — | render-only (no runtime) |

---

# Lean transpiler output (src/lean.js)

The renderers emitted a fixed prologue regardless of the script:

- the **C backend** prepended its whole `_sh_*` shell-out runtime (~40
  static helpers, ~9.7 KB) even for a trivial loop;
- the **sh backend** prepended the `_num()` arithmetic-coercion helper
  (dash can't coerce non-numeric arith values like bash does) even when
  the script never does arithmetic on a variable.

`src/lean.js` fixes this in the JS layer (the Rust generator lives in
the otranspilerl wasm, whose source is not vendored here):

- `leanC` — a string/comment-aware C scanner splits the prologue into
  `static` function/var segments, computes the transitive call graph
  from `main`, and drops every helper that nothing kept references.
  Everything is `static` (internal linkage), so removal is behavior-
  neutral by construction.
- `leanSh` — drops `_num()` when the body never calls it. `exec
  2>/dev/null` is kept: it's not a polyfill, it silences stderr from
  generated command substitution / external commands that don't exist
  in the target environment (e.g. `date` in the browser sandbox).

Wired into `src/otranspilerl.js` (`transpile`/`render` for the `c` and
`sh` targets), so the web GUI, the shell command and the jtsh fallback
all benefit. Verified: lean C compiles (tcc) and runs byte-identical to
raw output — for simple scripts AND runtime-hungry ones (arrays, param
expansion, substring, replace, file tests) where the reachability keeps
exactly the helpers used:

| script | raw | lean |
|---|---|---|
| `for i in 1 2 3 …` | 9727 B | 1462 B |
| `$(…)` command sub | 10058 B | 2770 B |
| arrays + param expansion + `[ -f ]` | 12332 B | 3135 B |
| sh hello (no arith) | 236 B | 68 B (no `_num`) |

---

# Backend lean audit + the otranspilerl rebuild path

"Hello world" output size across all NINE backends (after the work below):

| backend | hello size | note |
|---|---|---|
| c | 489 B (was 9727 B) | `trim_sh_runtime` in c_backend.rs — reachability over the `_sh_*` shell-out helpers; only `_sh_rc` survives for pure printf/loop output |
| go | 152 B (was 18471 B) | `go_used_helpers` in go_backend.rs — same reachability over the fixed `RUNTIME_HELPERS` block; imports trimmed to what the kept text references |
| js | 157 B | already short |
| pl | 126 B | already short (the verbose perl paste was the OLD wasm) |
| py | 179 B | already short |
| rs | 120 B | already short |
| zig | 207 B | already short |
| sh | 236 B → 68 B | `_num()` dropped when unused (Rust side still emits it; the JS `leanSh` trims it) |

All changes live in the sh2loop Rust source (`/home/llm/sh2loop/sh2perl`):
`src/c_backend.rs` (runtime bounds + trim + sys/wait.h gated behind the
surviving WIFEXITED users — tcc's bundled headers lack sys/wait.h),
`src/go_backend.rs` (helper/import trim), `src/wasi_api.rs` (the unified
`otranspilerl_*` C-ABI: transpile/shir/render/version/alloc/free/str_len,
same memory contract src/otranspilerl.js speaks).

`./build-wasm-otranspilerl.sh` rebuilds `www/wasm-bin/otranspilerl.wasm`
from that source. NOTE: the CURRENT sh2loop js backend emits plain JS
source (not the estree JSON the shell's `runViaTranspiler` fallback
surgery expects) and lowers some constructs (unquoted `$i` splitting) to
TODO markers — so the shipped shell keeps the PROVEN estree-based wasm;
the lean C/sh output already ships via the JS-side `src/lean.js`
wrappers, and the native trims land when the js backend matures.
Also added `$freopen`/`$setvbuf` stubs to `src/c-runtime.js` (the
generated main's stderr-silencing prologue needs them to link under
tcc; the wasm runner's data-segment globals still OOB — pre-existing).

---

# estree → JS: use a real generator (astring), not a hand-rolled emitter

The debashl estree output is STANDARD ESTree (16 node types — Program,
ForOfStatement, SequenceExpression, TemplateLiteral, sh2.* CallExpressions
…), so the shell's hand-rolled `src/estree.js` emitter (19 node types,
the source of the "unsupported statement ForStatement" gap) was
reinventing the wheel. The Rust crate's newer `js_backend` (source-
emitting) has the same problem in Rust (TODO gaps for unquoted splits).

Fix: vendored **astring** (`www/vendor/astring.mjs`, single file, MIT,
zero deps) — `src/estree.js`'s `estreeToJs` now delegates to
`astring.generate` (async — all call sites updated to await). Verified:
loops, `if [ -f … ]` with `await sh2.fs.lstat`, hello — all generate
cleanly, and all 82 curated examples still transpile + run through the
sh2 runtime (82 pass, 0 fail). The hand-rolled emitter stays as
`estreeToJsSync` (documented fallback).

---

# Native array lowering (src/lower.js)

The estree backend lowers shell arrays through the dynamic sh2.* runtime
store (`sh2.setArray`, `sh2.getVar("arr[1]")`, `sh2.param("slice",…)`)
— always correct, but heavy. The A1 analysis already proves simple
arrays (the C backend renders `char *arr[1024]` + `arr_len` natively),
so the JS path can too.

`src/lower.js` `lowerNativeArrays(estree)` rewrites the PROVABLE subset
to native JS, before astring generates:

```
sh2.setArray("arr", ["alpha","beta","gamma"])  →  let arr = ["alpha","beta","gamma"];
sh2.getVar("arr[1]")                            →  (arr[1] !== undefined ? arr[1] : "")
sh2.param("slice","#arr","@","")                →  arr.length
sh2.param("slice","arr","@","")                 →  arr.join(" ")
```

Guards (anything else keeps the runtime): more than one setArray, whole
`$arr` reads, `[*]`/`[@]` forms, element/whole writes (sparse writes
break `#arr[@]` == `.length`), and references inside function bodies.
Verified: native vs runtime output identical for all 7 probe scripts
(reads, computed `${arr[$i]}` indices, nested, whole-read, write, `[*]`,
function-scope); 82/82 examples still pass.

# Loop lastExit hoisting (src/lower.js hoistLoopLastExit)

Every command statement renders as `(cmd?, sh2.lastExit = N, flag)` — the
`flag` (true/false) is the statement's VALUE (the success flag `if`/`&&`
consume), and `sh2.lastExit` records `$?`. Inside a loop whose body sets
the SAME constant N every iteration, the per-iteration assignment is
redundant: `$?` reads anywhere in the loop see N anyway, and after the
loop it is still N. `hoistLoopLastExit` pulls a single
`sh2.lastExit = N;` out before the loop and drops the per-statement
assigns (keeping `(cmd, flag)`).

Guards: every sequence-flag statement in the body must assign the same
numeric literal, non-flag statements must not touch sh2.lastExit, and no
`sh2.lastExit` READ may appear in the body (a `$?` between different-
valued commands would break the invariant). While-loops are left alone
— their `__sh2_loop_last` wrapper reads lastExit per iteration.
Verified: hoisted output runs byte-identical to raw for 6 probe scripts
(including `$?` in/after the loop); 82/82 examples still pass.

# Success-flag trimming (src/lower.js dropDeadFlags)

A command statement's VALUE is its success flag (`(cmd?, flag)`) — that
is what `if`/`while`/`&&`/`||` consume and what the program's
last-statement exit-code convention reads. A standalone
ExpressionStatement's value is consumed ONLY as the program's last
statement (jtsh's runViaTranspiler turns it into the exit code), so
everywhere else the flag is dead:

```
(process.stdout.write(String(`count ${i}`) + "\n"), true)   →   process.stdout.write(String(`count ${i}`) + "\n")
```

`dropDeadFlags` removes the trailing flag from non-last
ExpressionStatements, unwraps 1-element sequences left by the lastExit
hoist, and drops literal-only dead statements. The last statement keeps
`(cmd, lastExit = N, flag)`; condition tests are untouched (they are
expressions, not statement-wrapped). Verified byte-identical against raw
output; 82/82 examples pass.

# bash.wasm `bash_web_spawn` LinkError (browser)

The bash-5.3 tree has an uncommitted "web-spawn bridge" in
execute_cmd.c: an `EM_JS` `bash_web_spawn` that runs top-level external
commands in the HOST shell via `globalThis.__bash_spawn` (bash.wasm
can't fork). The first bash.wasm build compiled it in unconditionally →
the wasm imports `env.bash_web_spawn` → in the browser the import was
not satisfiable → `Aborted(LinkError: Import #15 "env" "bash_web_spawn":
function import requires a callable)`.

Fix: rebuilt bash.wasm from the current source, where the bridge is
behind `#if defined(BASH_WEB_SPAWN)` (undefined) → the import is gone,
so the LinkError is impossible in any environment. (The `web` builtin's
`bash_web` import remains — the glue provides it and nothing calls it.)

Note for finishing the WIP: the current call site passes THREE args
(`bash_web_spawn(wargs, stdin_file, stdin_data)`) but the EM_JS declares
TWO — that won't compile with `BASH_WEB_SPAWN` defined; the signature
must be aligned, and a `globalThis.__bash_spawn(args, stdin)` host hook
wired (the webgui's runShell is the natural place).

# Init-assignment merge (src/lower.js mergeInitAssignments)

The estree emitter hoists every variable as `let v = DEFAULT` (TDZ +
conditional-assignment safety) then emits the real assignment as a
separate statement. When that assignment is unconditional and the FIRST
statement touching `v`, the two collapse exactly: `let x = 0; x = 6;`
→ `let x = 6;` (nothing observed the default in between). Adjacent
`let`s also merge: `let x = 6, y = 7;`.

Guards: no read/use before the candidate assignment, plain top-level
`=` (not `+=`, not inside a block/loop/function), RHS does not
reference the var (TDZ in the folded initializer). Verified byte-
identical vs raw output; 82/82 examples pass.

# If/else lastExit hoisting (src/lower.js hoistCommonLastExit)

Same invariant as the loop hoist, for branches: when EVERY branch (and
else-if chain) sets the same constant `sh2.lastExit = N`, `$?` is N
whichever path runs — so one `sh2.lastExit = N;` before the `if`
replaces the per-branch assigns. `if/else` becomes plain writes.

Guards: all branch command statements assign the same numeric literal;
no `$?` READ anywhere in the if; a lastExit member counts as a READ
unless it is the left of an `=` (the trailing assigns, or a same-value
write like the `true` builtin rendered as a test). Verified identical
vs raw output; 82/82 examples pass.

# Push hoisted lastExit to the end (src/lower.js pushLastExitToEnd)

After the loop/if hoists, a `sh2.lastExit = N;` before the construct
can move to the END of its statement list when every following
statement is lastExit-free: the construct's paths already set N
everywhere, and the neutral tail neither reads nor writes it, so the
value is N at every intervening point either way. Nested hoists then
merge into one trailing assignment. A `$?` read (or a trailing
command's own `(…, lastExit, flag)` wrapper) in the tail keeps the
assignment in place. Verified identical vs raw output; 82/82 pass.

# shIR "runs" markup: prove a loop body executes at least once

The estree while-lowering tracks whether the body ran (`__sh2_loop_ran` /
`__sh2_loop_last`) because bash's `$?` after a zero-iteration while is
the CONDITION's status, not the body's. When the loop provably runs,
that tracking is a no-op (the body's last command leaves sh2.lastExit
correct; the trailing `ran ? last : 0` write re-reads itself).

Implemented as SHIR MARKUP so all backends share the proof:

- `shir.rs`: `loop_provably_runs_in` — sound constant propagation over
  the statements before the loop + evaluation of a simple
  `test`-builtin condition (`"$i" -lt 3` with `i=0` → true). DoWhile
  always runs; For runs when its iterable is a non-empty literal
  Array/Range. `collect_provably_running_loops` records the statement
  pointers into the per-compilation `PROVABLY_RUNS` set.
- `shir_json.rs`: the A1 loop nodes carry `"runs": true` when proven —
  any backend consuming the contract knows the body runs.
- estree emitter: a provably-running native while skips the ran/last
  tracking (bare loop) but keeps the errexit guard.

Output for `i=0; while [ "$i" -lt 3 ]; do …` is now a bare
`while (i < 3) { … }`; unprovable loops (unknown vars, `until`, literal
false) keep the machinery. Verified 82/82 examples + webgui pass.

# Push lastExit to the latest safe point (pushLastExitToEnd refinement)

`pushLastExitToEnd` now moves a hoisted `sh2.lastExit = N;` to the
LATEST safe position: the very end of the statement list when the whole
tail is lastExit-free, else just BEFORE the first statement that reads
or writes lastExit (the value N is constant, so every neutral statement
in between observes the same N either way). A trailing `$?` reader keeps
the assignment immediately in front of it instead of before the whole
loop/if.

# Missing sh2 runtime functions (corpus example runtime gaps)

Running the sh2perl corpus examples through the sh→js path surfaced
runtime functions the estree emitter legitimately emits but the sh2
runtime didn't provide:

- `sh2.fs.mkdtemp(prefix)` — `mktemp -d` (the reported error). Creates a
  unique VFS dir (`.directory` marker convention) and resolves to its path.
- `sh2.captureSync(fn)` — the emitter's SYNC capture for sync builtins:
  the builtin RETURNS its output string, so captureSync just returns the
  arrow's result (trailing newlines stripped). A throw-stub with the same
  name was shadowing it — removed.
- `sh2.pipelineSync(fns)` — sync pipeline: stages are either literal
  strings (data flowing) or functions (a sync builtin whose RETURN is the
  stage output); feeds stdout→stdin like the async pipeline.
- `sh2.fs.rm` / `sh2.fs.unlink` — VFS remove (files or trees).
- Unknown sync builtins now behave like bash: `name: command not found`
  to stderr, `$?` = 127, and the script CONTINUES — instead of the
  runtime aborting the whole script.

`000__02_output_formatting_commands.sh` now completes; sha256sum/sha512sum
/head/tee report not-found (sync hashing/file access isn't implementable
synchronously in the browser) and the script carries on, bash-style.

# Source line pass-through + web GUI line map

The shIR already had a `stmt_lines` field, but only the C frontend
populated it. Now SHELL sources do too:

- `Lexer::current_line()` — the lexer tokens carry byte offsets; the
  line is resolved via the `line_starts` table (binary search).
- `Parser::parse_with_lines()` — records each top-level command's
  1-based source line (captured at the command's START token).
- `ast_to_ir_with_lines()` — fills `IrProgram.stmt_lines`
  (top-level stmt index → source line), serialized in the A1 as
  `stmt_lines: [{"stmt": i, "line": l}]`.

The web GUI consumes it: `estreeToJsMapped(program, stmtLines)` applies
the lower.js transforms, renders via astring, and builds a
statement→line map (`{ jsStart, jsEnd, sourceLine }` per meaningful
top-level statement, by per-statement re-render + cumulative offsets).
The new "source ↔ generated line map" panel shows both panes numbered;
clicking a generated line highlights the source line(s) it came from
and vice versa. (Best-effort: `mergeInitAssignments` folding an
assignment into a declaration maps the declaration to that assignment's
line — multi-statement scripts map exactly.)

NOTE: mid-task the sh2loop worktree reverted the earlier source changes
(runs markup, c/go trims, the otranspilerl ABI). The shipped wasm kept
the features; the source was re-applied in full before this rebuild, so
everything is consistent again.

# Clickable generated-code lines → source highlight (web GUI)

The generated-code panel is now a line-numbered, clickable view
(`renderCodeLines`). Clicking a generated line:
- highlights that generated row,
- looks up the source line via the A1 `stmt_lines` map
  (`jsLineToSource`),
- **selects + scrolls to that source line** in the input textarea
  (`selectSourceLine` — native selection is the highlight; focusing a
  textarea scrolls the selection into view).

Also fixed: loading a shared `#lang=…&code=…` URL set the source but
never ran it (applyUrlState returned before execute) — the generated
code stayed "—". It now executes after restoring the URL state.

# Line-map interaction fixes

- **renderLineMap bug**: it reset `otJsLines = []`, wiping the code lines
  `renderCodeLines` had set (the map panel's generated column rendered 0
  rows). Fixed.
- **Generated click → source**: clicking a generated-code line now
  explicitly MOVES the textarea cursor to the source line
  (`ta.focus()` + `setSelectionRange`), selects the line, and centers it
  in the visible area (`scrollTop` from the line height — the browser's
  default selection-scroll landed it at the bottom edge, hiding it).
- **Cursor move → generated**: instead of only the click handler, a
  document-level `selectionchange` listener (guarded to the source
  textarea) highlights the generated line(s) for the caret's line on
  EVERY caret move — clicks AND arrow keys.

# Line map for the sh target too

The line map was js-only (the estree path). The sh backend renders the
A1 top-level statements in order after a fixed prologue
(`#!/bin/sh` + `exec 2>/dev/null` + blanks [+ `_num(){…}`]), where each
statement occupies a KNOWN number of lines (blocks recurse: if/for/
while/case/function headers + bodies + closers). `buildTextMap` in the
web GUI matches that structure to the A1 `stmt_lines`, so clicking a
generated sh line now highlights + selects the source line it came from
(and cursor moves highlight the derived sh lines) — same interaction as
the js target. Verified exact on a script with if/for/case/function/
arith.

# Line map for all targets

The source↔generated line map now works for every text target, not just
js/sh:

- **pl**: EXACT — the perl backend already emits the shIR source-mapping
  convention (` # line N` per top-level statement, fed by the populated
  `stmt_lines`); the map parses those comments.
- **sh**: exact (existing).
- **py / c / go / rs / zig / java**: best-effort — the web GUI finds the
  body (inside `main()` or before the py trailing TODO-count comment)
  and walks the A1 statements with per-language block rules (py has no
  closing braces; brace languages count `{`/`}`). Simple statements map
  exactly; statements the backend transforms (loops → range/while with
  setup vars, and `// TODO(unsupported)` lines) can shift subsequent
  lines by the extra output they emit.

# Exact line maps for ALL targets (backend-emitted comments)

The counter-based best-effort maps for py/c/go/rs/zig DRIFTED when the
backends transformed loops (for→range/while with setup vars + TODO
comment lines). Fixed properly: every backend now emits the shIR
source-mapping comment on each top-level statement's first line (the
convention the perl backend already had):

- go / rs / zig / java: ` // line N`
- c: ` /* line N */` (including the const-lift decls — the Assign folded
  into a file-scope `const` declaration carries its `/* line N */`)
- py / pl: ` # line N`
- sh: unchanged (the recursive counter was already exact)

The web GUI parses those comments to build the line map — exact for
every target, no drift. Verified all of pl/py/c/go/rs/zig map a
script with assign/if/for/echo to the exact source lines.

NOTE (pre-existing, separate): the otranspilerl wasm's transpile goes
through an A1-JSON round-trip, which loses the STRING const-lift in the
c backend (`name="world"` renders without a declaration — numeric
consts survive). The debashl wasm's direct-IR path is correct. The
round-trip predates this work.

# c target: leanC was dropping code (fixed)

ROOT CAUSE of the c target's compile failures: `leanC`'s `splitPrologue`
called `matchC(prologue, i, c, c)` with open==close==`"` to skip quoted
strings — but `matchC`'s "code" state consumes the opening quote as a
string STARTER before the depth check, so the pair never matched and
`matchC` returned -1 → `i = 0` → the outer loop did an early `return`,
silently DROPPING the entire rest of the prologue: every `const char
name[] = "…"` const-lift decl AND every `_sh_site_N` function definition.
The c output referenced `_sh_site_N()` from main but never defined it —
no c output with a site function ever compiled. Fixed with a proper
backslash-aware quote skipper (handles `"a\"b"`).

Also fixed the same drop hiding the string const-lift: the const-decl
`/* line N */` comment now covers the string branches too
(`const char name[b]` and `const char* name`), not just numeric consts —
c maps are exact for string-const scripts as well.

VERIFIED: c output for name/if/for/arith scripts compiles with gcc and
runs correctly (hello world, big/small, item loops, 42).

NOTE (recurring): the sh2loop worktree reverts unpushed edits — the
backend comment patches (go/py/rs/zig/java/c statement loop, c const
comment) had to be re-applied once more after a revert. If a future
rebuild loses the line maps, re-check `grep -c 'line {l}' src/*_backend.rs`
(expect 1 in go/python/rust/zig, 3 in c) before rebuilding.
