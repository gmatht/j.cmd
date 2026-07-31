# sh2runtime — TODO

## Status (current)

The browser shell has a working Plan 9-style virtual filesystem with
mount points, tab completion, a CodeMirror text editor, command history,
and device files. It runs in any browser with no build step.

## Recently Done

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
      and run as commands from /bin/echo.wasm
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
      drop them in /bin/, run them as native commands.
      Needs WASI syscall implementation over VirtualFS.
      Example: `echo "hello" | grep hello` via real grep compiled to WASM.
- [x] Clipboard device: /dev/clipboard read/write
- [x] Git FS: mount a git repo as a filesystem (read tree, read blobs)
- [ ] WebGL device: /dev/webgl with shader/buffer/uniform files
- [ ] /dev/camera frame capture
- [ ] Audio device: /dev/audio oscillator
- [ ] /proc/ filesystem (process info, browser stats)
- [ ] Mount command: `mount github:user/repo /mymount`

### Integration with sh2perl

- [ ] Compile sh2perl to WASM
- [ ] Bash → JS transpilation in the browser
- [ ] Type `bash` commands, get generated JS executed
- [ ] Pipeline support via sh2perl's generated JS

### Polish

- [ ] `clear` respects scrollback
- [ ] Resizable terminal
- [ ] Color output for `ls` (dirs in blue, files in white, executables in green)
- [ ] Ctrl+C interrupt handling
- [ ] Config file (~/.tinyshrc or similar)
- [ ] `which` command
- [ ] `man <command>` or help pages
- [ ] Tab completion for partial paths (e.g., /mount/github/g<Tab> → /mount/github/gmatht/)

## Known Issues

- tinysh tokenizes quoted arguments: `echo "hello world"` is one argument
  (single quotes, double quotes, backslash escapes, empty args all handled)
- Pipes (`|`) are not supported — they fall through to `cat` which tries to
  read them as file paths
- RootFS doesn't support writing files outside mount points
- No `..` resolution past mount boundaries (e.g., `cd /tmp; cd ..` doesn't
  go to `/`)
