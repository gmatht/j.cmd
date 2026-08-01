# sh2runtime — TODO

## Status (current)

The browser shell has a working Plan 9-style virtual filesystem with
mount points, tab completion, a CodeMirror text editor, command history,
and device files. It runs in any browser with no build step.

## Recently Done

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
- [x] tinysh — minimal shell REPL (CLI + browser)
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
      vi <file> opens editor; vim is an alias; mode indicator in header
- [x] GitLabFS: browse gitlab.com projects as a filesystem
      (mount at /gitlab and /mount/gitlab)
- [x] Replace WASI stub with @wasmer/wasi (full spec-compliant WASI)
      https://www.npmjs.com/package/@wasmer/wasi
      - Wire @wasmer/wasmfs to our VirtualFS
      - Then any wasm32-wasi binary works as a command:
        grep, curl, python, etc.
- [x] C-to-WASM compiler: compile steinerkelvin/c-to-wasm-compiler-project
      to wasm32-wasi. It's a C compiler written in C++ that targets WASM
      (uses flex/bison, outputs .wasm). Currently has build errors with
      clang 18 (missing includes, std::transform, type issues). Needs:
      1. Fix native build (add <cstdint>, <algorithm>, type hierarchy)
      2. Cross-compile with wasi-sdk
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
- [x] Quoted arguments parsing in tinysh (currently splits on spaces blindly)
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
- [x] Config file (~/.tinyshrc or similar)
- [x] `which` command
- [x] `man <command>` or help pages
- [x] Tab completion for partial paths (e.g., /mount/github/g<Tab> → /mount/github/gmatht/)

## Known Issues

- tinysh tokenizes quoted arguments: `echo "hello world"` is one argument
  (single quotes, double quotes, backslash escapes, empty args all handled)
- Pipes (`|`) are not supported — they fall through to `cat` which tries to
  read them as file paths
- RootFS doesn't support writing files outside mount points
- No `..` resolution past mount boundaries (e.g., `cd /tmp; cd ..` doesn't
  go to `/`)
