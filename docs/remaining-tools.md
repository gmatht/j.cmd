# Remaining tools: implement as shell commands or in debashcl?

## The decision rule

| Category | Goes where | Why |
|---|---|---|
| Bash-language semantics | **debashcl** (compiler or the `sh2` runtime) | Entangled with variables, expressions, control flow — `[ ]`, `read`, `declare`, `echo`… A standalone command can't touch those. |
| Cheap idiom lifts | **debashcl** (compiler) | `$(seq 1 10)` → `sh2.seq(1,10)`, `wc -l FILE` → line count, `echo "$x" \| grep -q P` → `String(x).includes(P)` — no spawn, no round-trip. |
| Pure data/stream/file transformers | **shell command** (builtin or `/bin/*.js`) | Work from the bare prompt too (`ls \| wc -l` outside bash), option-heavy, no shell state. |
| Real engines | **wasm binary** | `sed`, `awk`, `bzip2`, `xz` — too heavy/complete to reimplement in JS; busybox → wasm32-wasi like `grep`. |

A tool can be **both**: a standalone command *and* a recognized idiom in the compiler (e.g. `seq` the utility exists, but `$(seq …)` inlines).

## Status (implemented)

This pass closed the entire shell-command batch and the debashcl idiom lifts, and
built the wasm binaries. `wget`/`jq` are deferred (see the wasm section for
reasons); `xz` is decompress-only (busybox's `xz` applet has no compression
path). Everything else is implemented.

### Native shell builtins added
`env` `hostname` `id` `yes` `xxd` `stat` `du` `df` `xargs` `mktemp`
(implemented in `src/shellcore/builtins.js`; `du`/`df` gained a bundled-flag parser
and `df` no longer walks mounts recursively — it's a per-mount listing, which is
correct and avoids a perf cliff on large mounts).

### Text utilities available via the uutils-wasm fallback
The shell's `exec` bridge auto-loads these from the cached uutils tarball when they
aren't native builtins. Covered: `wc` `sort` `uniq` `cut` `tr` `tee` `nl` `paste`
`shuf` `fold` `seq` `sleep` `touch` `date` `basename` `dirname` `printenv` `od`
`readlink` `realpath` `uname` `expand` `unexpand` `split` `csplit` `fmt` `cksum` `sum`. A representative smoke test (`cut`/`tr`/`sort`/`uniq`/`tee`/`nl`/
`paste`/`seq`/`sleep`/`basename`/`dirname`/`uname`/`touch`/`readlink`/`expand`/
`fold`/`cksum`/`sum`/`fmt`/`shuf`) passes from the bare prompt.

> **Enabling change:** the wasm (debashcl) emits a stale `SYNC_BUILTINS` set that
> lists `wc`/`head`/`sort`/`seq`/… as *sync* commands. Those aren't handled by the
> sh2 runtime's sync table, so `awaitSyncFnCalls` (in `src/estree.js`) now routes any
> `sh2.builtin("<stale-sync>")` call through `exec` instead of the (absent) sync
> helper. That single fix is what makes the whole uutils-wasm text-utility surface
> work through transpiled scripts.

### debashcl idiom lifts (done)
| construct | how it inlines | verified |
|---|---|---|
| `$(seq 1 10)` / `for i in $(seq a b)` | `sh2.seq(a, b)` → array, joined with `\n` | ✓ identical output, no spawn |
| `wc -l FILE` | `sh2.lineCount(file)` (VFS-aware) | ✓ |
| `wc -w FILE` | `sh2.wordCount(file)` | ✓ |
| `wc -c FILE` | `sh2.byteCount(file)` | ✓ |
| `echo "$x" \| grep -q P` | `String(x).includes(P)` (true/false, no spawn) | ✓ `grep -q` and `grep -q -v` |
| `echo "$x" \| grep -q -v P` | `!String(x).includes(P)` | ✓ |
| `test -f X && cat X` | `sh2.fileTest("-f", X) ? cat : ""` (guarded read) | ✓ |
| `sleep 0.1` | `sh2.sleep(ms)` (pre-existing) | ✓ |

New sh2-runtime helpers backing these: `sh2.seq`, `sh2.lineCount`, `sh2.wordCount`,
`sh2.byteCount`, `sh2.fileTest`, `sh2.sleep` (the `grep -q` lowerings emit
`String(x).includes(P)` directly against the captured string). They live in
`src/sh2runtime.js` so **all nine backends**
(c, go, java, js/estree, perl, python, rust, sh, zig) can emit them.

### SYNC_BUILTINS contract extended
`src/estree.js` `SYNC_BUILTINS` now includes the fast native builtins so transpiled
code calls them synchronously (no exec round-trip): `hostname id env stat du df xxd
mktemp` (in addition to the original `echo printf true false date pwd cat cd export
ls test`). The sh2 runtime's sync-table cases for those commands were added in
`src/sh2runtime.js`.

### wasm binaries
| tool | status | route / reason |
|---|---|---|
| `sed` | ✅ shipped (pre-existing) | busybox sed → wasm32-wasi |
| `awk` | ✅ built | `build-wasm-awk.sh` (busybox awk); registered via `WasmerRegistry`; `echo … \| awk '{print $2}'` works |
| `bzip2` | ✅ built | `build-wasm-xz.sh` builds busybox bzip2 too; roundtrip `echo X \| bzip2 \| bzip2 -d` works |
| `xz` | ✅ built | `build-wasm-xz.sh`; `xz -d` / `xzcat` verified. **Decompress-only**: busybox's `xz` applet is `unxz` under the hood (the config help literally says "you'll get xz applet, but it will always require -d option"), so compression (`xz -c`) is not available — use `bzip2` for compress. |
| `wget` | ⏸ deferred | wasi preview1 has **no sockets** — busybox wget needs `connect`/`send`/`recv`, which the grep/awk builds deliberately drop. HTTP is already covered by `curl` (JS `fetch`). Implementing wget would require a wasi-sockets build, out of scope. |
| `jq` | ⏸ deferred | no prebuilt `wasm32-wasi` jq is vendored here; building jq from source needs its full autotools/bison toolchain under wasi-sdk. JSON tooling via `jq` is deferred until a wasm build is vendored. |

The build toolchain: `build-wasm-awk.sh` and `build-wasm-xz.sh` (busybox awk/xz applets
→ wasm32-wasi, the same pipeline as `build-wasm-grep.sh` — x86 hash assembly and
network helpers dropped, wasi emulated-* libs linked). Both produce
`www/wasm-bin/<cmd>.wasm` and `WasmerRegistry` points at that directory.

## Test coverage
`__remaining-tools-test.mjs` asserts (flags / stdin / error paths):
- the newly-added builtins (`env`/`id`/`yes`/`xxd`/`stat`/`du`/`df`/`hostname`/
  `xargs`/`mktemp`),
- the uutils-wasm coverage set,
- the transpiled shape **and** executed result of every idiom lift
  (`$(seq …)`, `wc -l/-w/-c FILE`, `grep -q` match/no-match, `test -f && cat`),
- that `awk`/`bzip2`/`xz` are registered and their `.wasm` files are present.

## Original "remaining" lists (for reference)

### Remaining, recommended as **shell commands** — ALL NOW COVERED
Native builtins: `env id yes xxd stat du df hostname xargs mktemp`.
uutils-wasm fallback: `wc sort uniq cut tr tee nl paste shuf fold seq sleep touch
date basename dirname printenv od readlink realpath uname expand unexpand split
csplit fmt cksum sum`.

### Remaining, recommended **in debashcl** — ALL NOW DONE
`seq` → `sh2.seq`; `sleep` → `sh2.sleep`; `basename`/`dirname` → `${v##*/}` / `${v%/*}`;
`test`/`[`/`[[` → `sh2.test`; `echo`/`printf` debashcl builtins; idiom lifts
(`wc -l FILE` → `sh2.lineCount`, `echo "$x" | grep -q P` → `includes(P)`,
`test -f X && cat X` → guarded read); `read`/`mapfile`/`declare`/`local`/`let`/
`shift`/`trap`/`type`/`source` already runtime/compiler builtins.

### Remaining, recommended as **wasm binaries** — see status table above
`sed` (shipped), `awk`/`bzip2`/`xz` (built), `wget`/`jq` (deferred).

## Notes

1. **head/tail/sort/uniq/wc/sleep/cmp/comm** appeared in debashcl's `builtins.json`
   but only worked inside the harness sh2. After the `awaitSyncFnCalls` fix these are
   now available here too (via the uutils-wasm exec bridge), so the old "genuinely
   missing" caveat is resolved. `cmp`/`comm` are still in the list but were not part
   of this pass (low priority; covered by the same fallback if needed).
2. **Binary pipelines in transpiled (`-c`) scripts**: the sh2 runtime's pipeline
   buffers are string-based, so a binary roundtrip across wasm stages (e.g.
   `echo "$B64" | base64 -d | bzip2 -d`) can be corrupted by a UTF-8 round-trip.
   Single-command wasm (`echo X | bzip2 -d`) works everywhere, and binary roundtrips
   work at the **bare prompt** (the shell's byte-aware `runPipeline`). Fixing the
   transpiled path to carry `Uint8Array` is a separate, larger change.
3. **The two sh2 runtimes have diverged** (see the original note): the inline idioms
   (`sh2.seq`, `sh2.lineCount`, `sh2.fileTest`, …) are the safe, local wins and work
   without rebuilding `debashcl.wasm`.
4. **Effort estimates** in the original lists were rough JS sizes; the wasm items use
   the existing `build-wasm-*.sh` toolchain.
