# sh2runtime — TODO

## Status (current)

The browser shell has a working Plan 9-style virtual filesystem with
mount points, tab completion, a CodeMirror text editor, command history,
and device files. It runs in any browser with no build step.

## Recently Done

- [x] jtsh uses the otranspilerl library (the unified wasm: debashl core
      + all nine renderers) to convert bash concepts it doesn't parse
      into JS and run them: `;` separators, for/while loops, if/case,
      `[ … ]` tests, functions with args, arithmetic, `$?` — routed
      sh → A1 shIR → ESTree → JS against the sh2.* runtime (estree.js
      gained ForOf/Sequence/Conditional/regex; the runtime gained
      lastExit/positional, fnCall/callDirect, a node-style sh2.fs
      bridge, grepText and a sync builtin table incl. test/cd).

- [x] otranspiler: the unified transpiler command replaces debashc
      (v0.1.2 = "last version before otranspiler"). Extension-driven
      source→contract→target dispatch over the debashcl reactor (sh →
      ESTree → js/pl/shir) and the vendored go frontends (go/py/c/pl/
      zsh/fish → A1 shIR → c/sh/shir), all six frontend libs + the
      shir-emit-go emitter + the busybox CLI merged into ONE stdlib-only
      main.go, built on first use with the in-browser go toolchain and
      cached in /tmp (one artifact, one build). debashc's parse/file
      forms stay as drop-ins; www/bin/debashc.js is gone.

- [x] asciinema casts match the v2 spec: cumulative timestamps (real
      players had been running every session instantly), SGR colours, and
      vi/edit buffers rendered as TUI regions

- [x] Inline prompt editing: the prompt, typed text and a blinking block
      cursor live inside the terminal scrollback (last line), like a real
      shell — no more fixed bottom input bar. Printable chars, backspace,
      arrows, Home/End, Ctrl+A/E/U/K/W, Tab completion and history all
      edit the inline line; a hidden input captures keys + mobile
      keyboards. asciinema recording stays faithful (prompts, typed chars,
      backspaces as \x08, mid-line edits as \r+line+ESC[K redraws)

- [x] Path-based command execution: `./a.wasm`, `/home/x.js`, `../y.mjs`
      run files by path like /bin/sh (exit 126 for non-executable files),
      and WASI programs now run with the shell's cwd as their cwd so
      relative file args (`grep pat file`, `./a.wasm ./audiodemo.js`)
      resolve naturally

- [x] VirtualFS with mount-based routing (RootFS, RamFS, LocalStorageFS)
- [x] jtsh — minimal shell REPL (CLI + browser)
- [x] HttpFS — fetch CORS-enabled URLs as files
- [x] GitHubFS — browse repos as a filesystem with featured listing
- [x] DevFS — /dev/ devices (info, cpu, mem, webgl, clipboard, random...)
- [x] LocalStorageFS — persistent storage in browser
- [x] Tab completion (commands + paths)
- [x] CodeMirror editor via `edit <file>` (Ctrl+S save, Esc cancel)
- [x] Command history (Up/Down arrows)
- [x] Command suggestions (vim → edit, less → cat, etc.)
- [x] Convenience alias: /github → /mount/github
- [x] Sample content: /home/examples/ with scripts and README

## Next Up

### Short-term (single session)

- [x] Image display: `cat image.png` renders inline in browser terminal
- [x] Audio playback: `play music.mp3` plays with controls
- [x] `readBlob` API for binary file reading
- [x] `writeBlob` API for writing binary files
- [x] WASM binary support: compile Rust→wasm32-unknown-unknown
      and run as commands from /usr/bin/echo.wasm
- [x] Minimal WASI host in JavaScript (stdout, args, clock, random)
- [x] MicroPython WASM: python.wasm (363K) via PyPI — print(2+2) → 4
- [x] C→WASM via wasi-sdk: echoc.wasm compiles and runs in shell
- [x] Fixed WasmRunner: detect exported vs imported memory, memRef pattern
- [x] Status bar: context-sensitive hints based on current directory
      (GitHub: login hint · /dev/: devices · /tmp/: ephemeral)
- [x] `browse` command: opens current GitHub/GitLab dir in new browser tab
- [x] Language hints: python/node/gcc/java/rustc → wasmer
      (WASM is the native binary format, compilers run via WASM)
- [x] Vi-like editor: CodeMirror vim keymap + :w/:q/:wq/:x/:q! ex commands
- [x] Real bash 5.3 in the shell (`/bin/bash`): bash.wasm can't fork, so
      top-level external commands run in the host shell via an asyncify
      EM_JS hook (bash_web_spawn) — synchronous output order, correct $?,
      stdin redirects + here-strings, bash PWD passed to the host.
      Pipelines/$( ) still need a real fork and fail; `web <cmd>` remains
      as the fire-and-forget fallback. (execute_cmd.c patch at
      patches/bash-web-spawn.patch, build at build-wasm-bash.sh,
      docs/realbash.md)
      vi <file> opens editor; vim is an alias; mode indicator in header
- [x] GitLabFS: browse gitlab.com projects as a filesystem
      (mount at /gitlab and /mount/gitlab)
- [x] Replace WASI stub with @wasmer/wasi (full spec-compliant WASI)
      https://www.npmjs.com/package/@wasmer/wasi
      - Wire @wasmer/wasmfs to our VirtualFS
      - Then any wasm32-wasi binary works as a command:
        grep, curl, python, etc.
- [x] Real C compiler (cproc): the `cc` command runs michaelforney/cproc
      (wasm32-wasi, fork gmatht/cproc) → QBE IR → qbe2wasm → wasm binary.
      libc calls resolve to the shell's env runtime (src/c-runtime.js:
      printf/puts/malloc/string/memory funcs + a bump heap). cc hello.c
      && ./a.wasm works end to end.
- [x] C-to-WASM compiler: originally steinerkelvin/c-to-wasm-compiler-project
      (a C++ student project with NO licence file — "all rights reserved",
      so it was REMOVED: compiler.wasm, build-wasm-compiler.sh,
      wasm-compiler.patch and the wasmer entries are gone). The cc/compiler
      commands now run cproc (ISC) → QBE IR → qbe2wasm; tcc (LGPL-2.1)
      is also available (see docs/licences.md finding 1).
      Alternative: use tcc-wasm or wasm2c path.
- [x] Go in the browser: the REAL Go toolchain (cmd/compile + cmd/link)
      cross-compiled with GOOS=js GOARCH=wasm and run through Go's
      wasm_exec.js glue (build-wasm-go.sh). `go run main.go` compiles,
      links and runs in the shell; js/wasm binaries run as commands via
      a node-fs-style fs shim over VirtualFS (net/http → fetch API).
      Stdlib shipped as one gzipped bundle (wasm-bin/goroot.dat).
- [x] NetHack in the browser: the ACTUAL NetHack 3.6.7 compiled to WASM
      (emscripten, win/shim window system + Asyncify — the neth4ck
      monorepo, fetched by build-wasm-nethack.sh). `nethack` renders the
      TTY game in the shell (status/map/messages, ESC q quits, Ctrl+C
      returns); `nethack --demo` autoplays headlessly in the CLI.
- [x] Async commands: non-interactive commands (echo/ls/grep/sleep/go…)
      run as tasks — the prompt returns within ~100ms with a busy
      suffix (spinner + red unfinished-jobs count) and you can type
      ahead while they finish. State-modifying (cd/export/mount) and
      interactive (vi/nethack/REPLs/pagers) commands still block.
      Ctrl+C aborts all tasks; wait waits for them.
- [x] Background jobs: `cmd &` runs in the background (jobs/wait/kill
      builtins + man pages). In the browser the right quarter of the
      display is a jobs panel: non-minimized jobs split it equally
      vertically, each with a title bar — minimise (—) collapses to a
      dock row, kill (✕) terminates (137) or dismisses. Output streams
      into each job's slice; guarded capture keeps concurrent
      foreground output out of other jobs' redirects.
- [x] `ls -l` output format (permissions, size, date)
- [x] Pipe operator: `cat README.md | head -3`
- [x] `grep` builtin or command
- [x] `find` builtin or command
- [x] Quoted arguments parsing in jtsh (currently splits on spaces blindly)
- [x] `&&` and `||` conditional chaining
- [x] Environment variables ($PATH, $HOME, $USER)
- [x] `export` command

### Medium-term

- [x] IndexedDB FS backend (for files > localStorage 5MB limit)
- [x] DownloadFS: write to /pc/ triggers browser download
      cp file /pc · echo text > /pc/name.txt · binary via writeBlob
- [x] WASM/WASI runtime: compile Rust/C programs to wasm32-wasi,
      drop them in /usr/bin/, run them as native commands.
      Needs WASI syscall implementation over VirtualFS.
      Example: `echo "hello" | grep hello` via real grep compiled to WASM.
- [x] Clipboard device: /dev/clipboard read/write
- [x] Git FS: mount a git repo as a filesystem (read tree, read blobs)
- [x] WebGL device: /dev/webgl with shader/buffer/uniform files
- [x] /dev/camera frame capture
- [x] Audio device: /dev/audio oscillator
- [x] /proc/ filesystem (process info, browser stats)
- [x] Mount command: `mount github:user/repo /mymount`

### Integration with sh2perl

- [x] Compile sh2perl to WASM
- [x] Bash → JS transpilation in the browser
- [x] Type `bash` commands, get generated JS executed
- [x] Pipeline support via sh2perl's generated JS

### Polish

- [x] `clear` respects scrollback
- [x] Resizable terminal
- [x] Color output for `ls` (dirs in blue, files in white, executables in green)
- [x] Ctrl+C interrupt handling
- [x] Config file (~/.jtshrc or similar)
- [x] `which` command
- [x] `man <command>` or help pages
- [x] Tab completion for partial paths (e.g., /mount/github/g<Tab> → /mount/github/gmatht/)

## Known Issues

- jtsh tokenizes quoted arguments: `echo "hello world"` is one argument
  (single quotes, double quotes, backslash escapes, empty args all handled)
- Pipes (`|`) are not supported — they fall through to `cat` which tries to
  read them as file paths
- RootFS doesn't support writing files outside mount points
- No `..` resolution past mount boundaries (e.g., `cd /tmp; cd ..` doesn't
  go to `/`)

### tcc fork: fix tests2 suite failures under wasm32 output

The wasm-generating tcc fork (gmatht/tinycc, wasm32 backend) fails its
own tests2 corpus when generating wasm. Baseline (150 tests, fork's
run-corpus.mjs): PASS 51 · WRONG 17 · REFUSE 60 · COMPILE-OUT 9 ·
RUN-CRASH 2 · RUN-ERR 2 · NO-EXPECT 9.

FINAL (2026-08-13, second pass): PASS 89 · WRONG 4 · REFUSE 16 ·
RUN-CRASH 4 · RUN-ERR 0 · NO-EXPECT 9. Long-double const loads now cast
through c.ld (22_floating_point); the c-runtime has the full 1/2/4/8-
byte __atomic_* matrix (125_atomic_misc near its expect). Fixes: bss zero-fill (segfault), NOP dead regions +
suppressed dead-region edges (hangs), _start argv, long-double f64,
br_table/br LEB encoding, inverted VT_JMP (&&/||), symbol constant
offsets (array[i]), function-value table (atexit/ctors), output-time
global addresses, __wasm_call_ctors. Remaining WRONG are mostly
harness expectations (-dt/compile-warning tests, WASI argv) plus a few
codegen gaps (17_enum varargs, 22 float math, 40_stdio files,
104 static visibility); REFUSE = documented feature gaps (fn pointers,
VLA, struct-by-value, i64 varargs, asm, TLS/pthread, bcheck). Plan:

- [x] wasm32-gen.c: bss section is emitted by reading bss_section->data
      (NULL — bss has no initialized content) → segfault (32_led).
      Emit zeros instead.
- [x] wasm32-gen.c: remove the unconditional L:/E:/G:/S: w_layout debug
      prints that pollute every compile's stderr.
- [x] wasm32-gen.c: guard the LEB128 edge-target emit against target=-1
      (unresolved label → infinite loop / OOB write).
- [x] Investigate + fix the 9 COMPILE-OUT tests (27_sizeof, 31_args,
      39_typedef, 48_nested_break, 54_goto, 70_floating_point_literals,
      89_nocode_wanted, 93_integer_promotion, 94_generic): tcc emits
      wasm that fails V8 validation (stack underflow / bad opcode).
- [x] Fix the 2 RUN-CRASH tests (03_struct, 136_atomic_gcc_style):
      "unreachable" trap — likely an infinite pc-dispatch loop.
- [x] Fix 11_precedence + 50_logical_second_arg (&&/|| short-circuit
      precedence wrong: line 3 got "1" want "0").
- [x] Fix 108_constructor: __wasm_call_ctors / atexit destructors not
      running ("constructor"/"destructor" missing).
- [ ] Fix 17_enum vararg slot collision (documented root cause).
- [x] Harness: pass ARGS (31_args, 46_grep), FLAGS (-lm, -dt, -pthread)
      and apply the upstream platform SKIP list so diagnostics/linker
      tests are measured fairly.

## Next Up (tcc wasm corpus, from PASS 69)

- [x] Harness: capture tcc's compile stderr (warnings) into the test
      output like the upstream Makefile's T3 — fixes 03_struct and
      102_alignas (the .expect's first line is a compile warning our
      tcc does emit, the runner just drops it).
- [x] Harness: apply the upstream platform/feature SKIP list (arm64
      139, riscv 141, bcheck/backtrace 113/117/126/114/115/116,
      pthread 106/124, tls 144/146) so the WRONG list is honest.
- [x] Harness: normalize per-line trailing whitespace (38's .expect
      strips it on lines 1-3 but not 4 — the program output is correct).
- [x] Harness: -dt mode for 60_errors_and_warnings, 96_nodata_wanted,
      125_atomic_misc, 128_run_atexit (compile each [test_x] section
      separately like tcc -dt -run) — validates error recovery.
- [x] Codegen: vararg slot collision (17_enum fixed; 22_floating_point's —
      args share one register slot when a later gv reuses it; the push
      reads a stale slot). The documented hard one; read each arg's
      CURRENT location (register or saved home) without perturbing
      w_layout.
- [ ] Codegen: function pointers (call_indirect) — the table + element
      section + env-runtime fn-call infra exists; emit call_indirect
      instead of "indirect call unsupported" (07, 33, 42, 81, 82 + real
      callback code).
- [ ] Codegen: RUN-CRASH dispatch traps (136_atomic_gcc_style,
      93_integer_promotion) — w_layout label→sub resolution.
- [ ] Codegen: i64 varargs (~8 REFUSE: 95, 110, 111, 118, 119, ...).
- [ ] Runtime: 40_stdio file I/O (env $fopen/$fgets... backed by the
      WASI fs).
