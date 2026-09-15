# Polyfill wiring status (runtime/ polyfills → backends)

Goal: *wire the otranspilerl output renderers to invoke the `runtime/`
polyfills for builtins/commands that lack a native idiom lift, instead of
shelling out via `bash -c` / subprocess / popen.*

Status assessed 2026-08-27 against the rebuilt `otranspilerl.wasm`
(8.6M, `build-wasm-otranspilerl.sh` green; `__idiom-lifts-test.mjs` and
`__remaining-tools-test.mjs` both pass).

## 1. The polyfill set (exists, complete, verified)

- `runtime/polyfills.sh` — the pure-CPU `sh2.*` core, authored in **bash**
  (21 functions + 4 helpers): `test`, `contains`, `globMatch`, `param`,
  `wcLines`/`headLines`/`tailLines`, `line_count`/`line_at`, `brace`,
  `basename`/`dirname`, string ops. No I/O, no process model.
- `runtime/polyfills.c` → `libsh2poly.a`/`.so` — the C complement: the
  host-bound seam (`exec`, `capture`, `fs_*`, `pipeline`, `redirect`,
  `background`, `subshell`, `exit`), the **IO-bound builtins** (`cat`,
  `ls`, `grep`, `sed`, `sort`, `wc`, `head`, `tail`, `cp`, `mv`, `rm`,
  `mkdir`, `date`, `uname`, …), the **native-C builtins** (`echo`,
  `printf`, `seq`, `let`, `true`, `false`, `:`, `cd`, `pwd`), and the
  state builtins (`declare`, `export`, `read`, `set`, `shift`, `unset`,
  …).
- Coverage: `runtime/check-coverage.py` maps **all 68** `sh2perl`
  builtins to bash or C — zero gaps.
- Consumption contract verified: the per-backend adapters
  (`runtime/adapters/{c,go,java,perl,python,rust,zig}`) reproduce the C
  self-test oracle byte-for-byte on `adapters/battery.txt` (`make
  adapters`). Spot-checked here: `sh2.cat`/`sh2.wc`/`sh2.true` via the
  python ctypes adapter match real bash output.

## 2. Key finding: which polyfills actually eliminate fork/exec

| polyfill class | fork? | note |
|---|---|---|
| native-C builtins (`echo`, `printf`, `seq`, `let`, `true`, `false`, `:`, `cd`, `pwd`) | **no fork** | implemented directly in C |
| pure-CPU `sh2.*` (`test`, `contains`, `param`, …) | **no fork** | transpiled per backend |
| IO-bound builtins (`cat`, `grep`, `wc`, `ls`, `sed`, `sort`, `head`, `tail`, …) | **still forks** | `polyfills.c` *delegates* to the host tool ("the host IS the implementation") |

So "fork/exec for polyfill-covered builtins drops to zero" is achievable
**only** for the native-C builtins and the pure-CPU functions. Routing the
IO-bound builtins through the polyfill uses the polyfill *contract* but
does not remove the fork (the C polyfill execs the host tool).

## 3. Per-backend status

| backend | native-C builtins today | polyfill wiring | blocker |
|---|---|---|---|
| **sh** | bash-compatible output (no transpiler-level fork) | not needed — emits bash | — |
| **js/estree** | hand-written `sh2.*` runtime (M2) | not needed — runtime is the polyfill equivalent | documented boundary (README §1b) |
| **python** | **already native** (`printf`→`sys.stdout.write`, `true`/`false`, `cd`→`os.chdir`, `let`→native, `seq`→native lift) | routing IO-bound builtins through `sh2.*` would add a hard `libsh2poly.so` dependency with **zero fork reduction** (delegation) | not beneficial without a fallback; would regress tests/gate that run without the polyfill module |
| **c** | routes **everything** through `bash -c` (text-rebuild model) | the valuable target, but the renderer builds shell *text* and runs it via `bash -c` — emitting `sh2poly_dispatch(argc,argv)` needs a new site kind + argv construction; README §8: full polyfill transpilation blocked on fixed-buffer tokenizer, command-sub recursion stack frames, cross-function global-var collisions | architectural (renderer text model + the three M4 limits) |
| **go** | routes everything through `os/exec` | emits ~1981 lines but **40 `TODO` markers** for `sh2.*` runtime helpers; not runnable | README §8 |
| **zig** | routes everything through `std.process` | emits ~1710 lines but **278 `TODO` markers**; not runnable | README §8 |
| **perl** | routes everything through `bash -c` (active backend is `src/generator/`) | not wired; the active perl generator is a separate module | README §8 (unverified) |
| **rust** | routes everything through `std::process` | CLI bug: `--target rs` errors (`unknown target 'rust'`); runtime status unverified | README §8 |

## 4. Conclusion

- The polyfill set is complete and its consumption contract is verified.
- The backends that would benefit most (c, go, perl, rust, zig — they
  fork for *every* builtin) are **blocked by documented architectural
  limits** (renderer text model; Go/Zig `TODO` markers; Rust CLI bug).
- The tractable backends (sh, js, python) already run the native-C
  builtins without a fork, so wiring them to the polyfills adds a runtime
  dependency with no fork reduction.
- Therefore the goal's "fork/exec → 0 for polyfill-covered builtins"
  criterion is met only where it is already met (native-C builtins on
  sh/js/python) and is **not achievable for the IO-bound builtins via the
  C polyfill** (delegation). Unblocking the deferred backends requires
  the architectural changes tracked in `runtime/README.md` §8 (C:
  fixed-buffer length analysis + per-function stack frames + local
  isolation; Go/Zig: runtime-helper emission; Rust: target-name fix).
