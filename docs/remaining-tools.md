# Remaining tools: implement as shell commands or in debashcl?

## The decision rule

| Category | Goes where | Why |
|---|---|---|
| Bash-language semantics | **debashcl** (compiler or the `sh2` runtime) | Entangled with variables, expressions, control flow — `[ ]`, `read`, `declare`, `echo`… A standalone command can't touch those. |
| Cheap idiom lifts | **debashcl** (compiler) | `$(seq 1 10)` → `sh2.seq(1,10)`, `wc -l FILE` → line count, `echo "$x" \| grep -q P` → `String(x).includes(P)` — no spawn, no round-trip. |
| Pure data/stream/file transformers | **shell command** (builtin or `/bin/*.js`) | Work from the bare prompt too (`ls \| wc -l` outside bash), option-heavy, no shell state. |
| Real engines | **wasm binary** | `sed`, `awk`, `bzip2` — too heavy/complete to reimplement in JS; busybox → wasm32-wasi like `grep`. |

A tool can be **both**: a standalone command *and* a recognized idiom in the compiler (e.g. `seq` the utility exists, but `$(seq …)` inlines).

## Already implemented

- **Shell builtins**: `ls cat echo pwd cd export rm mkdir cp mv head tail grep find mount unmount wasmer which man help true false su whoami chmod chroot` + browser `edit vi play clear history locate browse resize stty asciinema less more wat2wasm`
- **/bin commands**: `at cron time watch screen xterm arecord perl lua diff cowsay fortune figlet sl cmatrix mail xclip xeyes webgldemo audiodemo sh2js sh2perl debashc llm base64 base32` + `curl gzip gunzip zip tar tree md5sum sha256sum uptime` (2026-08)
- **wasm-bin**: `cc grep python sh2perl debashcl echo echoc make wasm-diff`

## debashcl builtins — do NOT re-implement as commands

`. : break cd cmp comm command continue declare echo eval exit export false head let local mapfile printf pwd read readarray readonly return set shift sleep sort source tail trap true type typeset uniq unset wait wc`

These are bash-internal (or handled by the toolchain). Caveat: several are *text utilities* the harness sh2 implements only for its sandbox (`wc sort uniq head tail sleep cmp comm`); they still make sense as shell commands here because this repo's sh2 execs through the shell — see the next section (`head`/`tail` set the precedent).

## Remaining, recommended as **shell commands**

| command | what | effort | notes |
|---|---|---|---|
| `wc` | lines/words/bytes | ~15 ln | the pipe staple |
| `sort` | `-r -n -u`, stdin+files | ~20 ln | |
| `uniq` | dedupe, `-c` | ~15 ln | |
| `cut` | `-d -f` fields | ~25 ln | |
| `tr` | translate/delete, `-d -s` | ~30 ln | |
| `tee` | stdout + write files | ~10 ln | |
| `nl` | numbered lines | ~15 ln | |
| `paste` | join lines/columns | ~15 ln | |
| `shuf` | random shuffle | ~10 ln | |
| `fold` | wrap lines | ~15 ln | |
| `seq` | number ranges | ~10 ln | also inline in debashc (below) |
| `sleep` | delay | ~5 ln | also inline (below) |
| `touch` | create/update files | ~10 ln | |
| `date` | current time, formats | ~12 ln | |
| `basename`/`dirname` | path ops | ~5 ln | also inline via `${v##*/}` |
| `env`/`printenv` | environment | ~8 ln | |
| `id` | user/groups | ~8 ln | |
| `yes` | repeat output | ~5 ln | |
| `od`/`xxd` | hex dump | ~40 ln | fills the unbuilt `hexdump` wasmer entry |
| `stat` | size/type/mtime | ~12 ln | |
| `du`/`df` | VFS-aware usage | ~15 ln | |
| `readlink`/`realpath` | path resolution | ~10 ln | |
| `uname`/`hostname` | system info | ~8 ln | `/dev/info` exists but these are script-friendly |
| `xargs` | build commands from stdin | ~25 ln | pairs with `find` |
| `expand`/`unexpand` | tab conversion | ~15 ln | |
| `split`/`csplit` | split files | ~25 ln | |
| `fmt` | rewrap text | ~20 ln | |
| `mktemp` | temp names | ~8 ln | |
| `cksum`/`sum` | simple checksums | ~10 ln | |

## Remaining, recommended **in debashcl**

| construct | how it inlines |
|---|---|
| `seq` | `$(seq 1 10)` / `for i in $(seq a b)` → `sh2.seq(a, b)` returning the array — no spawn, no command substitution. The highest-value inline. |
| `sleep` | `sleep 0.1` in a loop → `sh2.sleep(ms)` — pure control flow. (Already a harness builtin.) |
| `basename`/`dirname` | lower to existing parameter expansion `${v##*/}` / `${v%/*}` — zero new machinery. |
| `test` / `[` / `[[ ]]` | already `sh2.test` (expression + variable coupled) — the model to follow. |
| `echo` / `printf` | already debashcl builtins (var expansion, `%s`). |
| idiom lifts | the compiler already does these (e.g. `echo X \| grep P >/dev/null 2>/dev/null` → substring compare). Next: **`wc -l FILE` → `sh2.lineCount(file)`**, **`echo "$x" \| grep -q P` → `includes(P)`**, `test -f X && cat X` → guarded read. |
| `read` / `mapfile` / `declare` / `local` / `let` / `shift` / `trap` / `type` / `source` | already runtime/compiler builtins — never shell commands (variable state). |

## Remaining, recommended as **wasm binaries**

| tool | route | notes |
|---|---|---|
| `sed` | busybox sed → wasm32-wasi (the `grep` build pattern) | a JS subset (`s///g p d ranges`) is a stopgap only |
| `awk` | busybox awk → wasm32-wasi | real awk is too big for JS |
| `bzip2`/`xz` | busybox → wasm | gzip is done in JS (pako) |
| `wget` | busybox → wasm | curl is done in JS (fetch) |
| `jq` | jq → wasm (there are wasm builds) | JSON tooling for scripts |

## Notes

1. **head/tail/sort/uniq/wc/sleep/cmp/comm** appear in debashcl's `builtins.json`, but that list only works inside the harness sh2. This repo's sh2 execs through the shell, so these are genuinely missing here — implement them as shell commands (`head`/`tail` set the precedent).
2. **The two sh2 runtimes have diverged**: this repo's `src/sh2runtime.js` matches its older bundled `debashcl.wasm` (emits `arithEval`, `pipeline`, `forLoop`…); the reference harness sh2 (`10.42.0.1:/nvme/ai/sh2loop/harness/sh2-namespace.mjs`) targets the current sh2perl emitter (`arith`, `join`, `return`, `assign`, `contains`…). Full alignment means rebuilding `debashcl.wasm` from current sh2perl **and** porting the reference sh2 surface — until then, the inline idioms above are the safe, local wins.
3. **Effort estimates** are rough JS sizes for the shell-command batch; the wasm items assume the existing `build-wasm-*.sh` toolchain.
