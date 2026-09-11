# Maintenance: frontend sync → build → examples → gates → deploy

The otranspiler web GUI (`www/otranspiler.html`) parses non-shell sources
through a prebuilt Go busybox (`www/wasm-bin/otranspiler-busybox.wasm`)
and offers the per-frontend testdata as loadable examples
(`www/examples/<lang>/`). Three scripts own the repetitive parts —
**use them instead of doing it by hand** (hand-syncing has twice
clobbered the vendored-only adapters and twice shipped a stale wasm):

```
./sync-frontends.sh [--check]   # 1. vendor latest sh2loop frontends
./build-wasm-busybox.sh         # 2. rebuild the merged wasm (~2 min)
./import-testdata.sh <lang>     # 3. import new corpus examples
./gate-bisect.sh <file> <lang>  # 4. (on failure) blame the right layer
./deploy.sh [--allow-dirty]     # 5. gates + push + rsync
```

## 1. sync-frontends.sh

Copies `frontends/*/` → `www/bin/` per the file table (which mirrors
`FRONTEND_FILES` in `src/busybox.js` — update both together).
It enforces, in order:

1. **cgo guard** — refuses the sync if any normally-pure frontend gains
   a non-wasm-buildable import (`"C"`, `runtime/cgo`, `*tree-sitter*`).
   `cpp-sh-go` is the known exception: upstream is cgo, so its vendored
   pure-Go tokenizer is never touched (only by hand, deliberately).
2. **copy** — plus warnings for new upstream `.go` files the table
   doesn't cover, and for missing upstream files.
3. **vendored-only adapters** (idempotent — safe to re-run):
   - `bat-sh-go`: `Shir` wrapper around upstream `Parse`
   - `go-sh`: drop the `runtime/debug` import + `PANICSTACK` stack dump
     (the browser GOROOT bundle lacks it; diagnostic-only upstream)
4. **post-copy guard** — the vendored tree must be stdlib-clean
   afterward (catches an adapter whose anchors moved upstream).

`--check` reports drift without changing anything (exit 1 on
unexpected drift; the two adapter files are expected to differ).

## 2. build-wasm-busybox.sh

Merges all frontend libs + `shir-emit-go` + the dispatcher into one
stdlib-only `main.go` and compiles with the in-browser Go toolchain.
After any sync, bump `BUSYBOX_VERSION` in `src/busybox.js` (cache-buster
for the staged VFS copy) and smoke-test every frontend through
`busyboxA1()` before committing.

## 3. import-testdata.sh <lang>

`py|go|c|cpp|pl|sh|bat|fish|zsh|zig` — copies new upstream testdata
files into `www/examples/<lang>/` (never deletes; hand-written demos
live alongside) and regenerates `index.json` in canonical form
(single-line array, preserving each file's existing item-separator style, no trailing newline).
Verify newcomers parse: `gate-bisect.sh www/examples/<lang>/<file> <lang>`.

## 4. gate-bisect.sh <file> <srclang>

When a transpile gate fails, this tells you WHICH layer broke so you
fix the right repo — stages run cheapest-first, and a passing stage
exonerates everything beneath it for that input:

| stage | what it runs | a FAIL means |
|---|---|---|
| 0 SYNC-CHECK | diff vendored vs sh2loop tree | stale vendor — run `./sync-frontends.sh` |
| 1 UPSTREAM | real Go frontend via `go run` (or compile check) | upstream bug — fix in sh2loop, then re-sync |
| 2 BUSYBOX-WASM | `busyboxA1()` via the prebuilt wasm | merge/build issue (`src/busybox.js`, adapters, or stale wasm — rebuild) |
| 3 RENDER-JS | otranspilerl render to js | backend gap — sh2loop/sh2perl or the JS runtime |
| 4 RUN | skipped (needs a harness) | finish by hand (adapt a `__*-test.mjs`, or `source` in jtsh vs native) |

Exit 0 only if every runnable stage passes.

## 5. deploy.sh

Refuses a dirty tree (commit first) and failing gates. `--allow-dirty`
ships the tree as-is (gates still run); `--skip-tests` is emergency
only. Known pre-existing gate failures (not deploy blockers for
transpiler work — verify each is genuinely unrelated before ignoring):
sound harness flakes, `claim2-live`, the two `t27/t30_goto` frontend
DIFFs. Never weaken a failing test to deploy — fix the product, or
document the failure as pre-existing with the A/B evidence.
