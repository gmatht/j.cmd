# Commands inventory — everything implemented, where and how

Every command surface in the shell, grouped by implementation layer, with
the count. User-facing command names are unique across layers (a name
lives in exactly one place, except toolchain builtins that shadow nothing).

Quick totals: **95 user-facing commands** (28 shell builtins + 13 browser
builtins + 45 `/bin` scripts + 9 wasm-bin artifacts). Inside bash,
another **25 debashcl-only builtins** are invocable (34 toolchain builtins
minus 9 that are also shell builtins). The **`sh2.*` runtime API is NOT a
command surface** — it is an internal JS interface for generated code.

## 1. Shell builtins — native JS, both shells (28)

`src/tinysh.js` and `www/index.html` each define the same `builtins`
table; async JS functions run in the shell process.

| command | how |
|---|---|
| `ls` `cat` `echo` `pwd` `cd` `export` `rm` `mkdir` `cp` `mv` `head` `tail` `grep` `find` `which` `man` `help` `true` `false` `exit` | core VFS/file/pipe utilities (JS) |
| `mount` `unmount` | VirtualFS mount table |
| `wasmer` | wasm package manager (wasm-bin registry) |
| `su` `whoami` `chmod` `chroot` | permissions / user switching (fs.attrs, suState) |
| `bash` `bash2js` | transpiler front-ends (bash REPL when bare) |

## 2. Browser-only builtins — native JS in `www/index.html` (13)

| command | how |
|---|---|
| `edit` `vi` | CodeMirror editors (vim keymap) |
| `play` | `<audio>` element from readBlob |
| `clear` `resize` `stty` | terminal viewport / geometry |
| `history` | persisted command history |
| `locate` | visited-paths + local scan search |
| `browse` | open current dir in a tab |
| `less` `more` | pager (alias → cat) |
| `asciinema` | session recording (v2 casts) |
| `wat2wasm` | WAT → wasm compile (wabt) |

## 3. `/bin` command scripts — seeded `.js` from `src/fs/index.js` (45)

Each is version-gated content written to the VFS at boot and run through
the shell's command loader.

**Core utilities & toolchain (13):** `time` `watch` `at` `cron`
(scheduler, `src/jobs.js`) · `sh2js` `sh2perl` `debashc` (debashl
toolchain facade, `src/sh2lib.js` + `debashcl.wasm`) · `base64` `base32`
(RFC 4648) · `diff` (wasm-diff lib) · `llm` (OpenRouter API).

**Interpreters (2):** `perl` (zeroperl reactor, `@6over3/zeroperl-ts`) ·
`lua` (wasmoon, `vendor/wasmoon.mjs`).

**Archives & transfer (7):** `gzip` `gunzip` `zip` `tar` (pako in the
browser / node:zlib in the CLI; tar streams `/pc` via StreamSaver) ·
`curl` (fetch) · `md5sum` (pure-JS MD5) · `sha256sum` (Web Crypto).

**Devices & toys (9):** `xclip` (clipboard) · `xeyes` `xterm` `screen`
`sl` `cmatrix` (DOM/canvas toys) · `webgldemo` `audiodemo` (device
demos) · `arecord` (microphone → WAV).

**Fun (8):** `cowsay` `fortune` `figlet` `counter` `sayhello` `mail`
(site commands below).

**Site openers (8, generated from `SITE_CMDS`):** `youtube` `reddit`
`slashdot` `lwn` `hn` `github` `wikipedia` `arxiv` (window.open / print URL).

## 4. wasm32-wasi binaries — `www/wasm-bin/` (9)

Run via `@wasmer/wasi` (`src/wasm.js`); auto-loaded on first use or
installed with `wasmer install`.

| binary | what |
|---|---|
| `compiler` (cc) | C → wasm compiler |
| `grep` | busybox grep (wasm32-wasi) |
| `python` | MicroPython |
| `sh2perl` | bash → Perl transpiler (Perl path fallback) |
| `debashcl` | unified debashc CLI reactor (ESTree/Perl generation) |
| `echo` `echoc` | demos (Rust / C) |
| `make` | 39-byte stub — **not built** |
| `wasm-diff` | wasm-bindgen *library* (driven by `/bin/diff.js`), not a runnable command |

`wasmer` registry also lists `hexdump` and `which` with **no binary built**.

## 5. debashcl builtins — the toolchain's language surface (34)

What debashcl / the sh2 runtime handles *inside* generated bash code (the
reference list from the sh2perl harness `builtins.json`):

```
. : basename break cd cmp comm command continue declare dirname echo eval
exit export false head let local mapfile printf pwd read readarray readonly
return seq set shift sleep sort source stat tail touch trap true type
typeset uniq unset wait wc
```

How: `echo`/`printf`/`test`/`read`/`declare`/`seq`/`sleep`… are lowered by
the compiler to `sh2.*` calls or native JS; the rest exec through the
shell. Caveat: `head tail sleep sort uniq wc cmp comm seq basename dirname
stat touch` are text utilities that only work inside the harness sh2 —
this shell's sh2 execs through the shell, so they're also implemented (or
candidates) as real shell commands (`head`/`tail` done; the rest are in
`docs/remaining-tools.md`).

## 6. `sh2.*` runtime API — `src/sh2runtime.js` (29) — NOT commands

These are the JavaScript functions debashcl's generated code calls. They
are **not user-runnable**: nothing in the command path resolves `sh2.*`,
the shell's tokenizer never sees them, and they only exist as the `sh2`
parameter injected into the scope of the transpiled JS (wired to a
`createSh2Runtime` instance). `sh2.exec echo hi` at the prompt is
"command not found"; even inside `bash -c`, `sh2.exec` parses as a
command named `sh2.` and fails. Treat them as an implementation surface:

```
exec pipeline capture captureWords redirect test
forLoop whileLoop caseMatch define brace param arith guard and or
arithEval setArray setArrayAppend arrayIndex arrayLen assign
break continue idiv imod not setLastExit getVar setVar
```

```
exec pipeline capture captureWords redirect test
forLoop whileLoop caseMatch define brace param arith guard and or
arithEval setArray setArrayAppend arrayIndex arrayLen assign
break continue idiv imod not setLastExit getVar setVar
```

## Counts

| layer | count | runnable? |
|---|---|---|
| Shell builtins (both shells) | 28 | yes — at the prompt |
| Browser-only builtins | 13 | yes — browser shell |
| `/bin` command scripts | 45 (37 regular + 8 site commands) | yes |
| wasm-bin artifacts | 9 (7 runnable + make stub + wasm-diff lib) | yes (auto-load/install) |
| **User-facing total** | **95** | |
| debashcl builtins (toolchain) | 34 | only inside `bash`; 9 are also shell builtins, so **25 bash-only** |
| `sh2.*` runtime API | 29 | **no — internal JS interface for generated code** |

**Invocable command names: 95 user-facing + 25 bash-only = 120.** The
29 `sh2.*` functions are not commands and add 0 to that count.

## Regenerating

```bash
# shell builtins
grep -oE '^  async [a-zA-Z0-9_]+\(args\)' src/tinysh.js | sed 's/async \([a-z0-9_]*\)(args)/\1/'
# browser-only
comm -13 <(…CLI…) <(…index.html…)
# /bin seeds
grep -oE '"/bin/[a-z0-9_-]+\.js"' src/fs/index.js | sed 's/"\/bin\///;s/\.js"//'
# wasm-bin
ls www/wasm-bin/ | sed 's/\.wasm//'
# debashcl builtins: /nvme/ai/sh2loop/harness/builtins.json
```
