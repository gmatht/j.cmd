# Real bash (bash.wasm) + the synchronous web-spawn bridge

`/bin/bash` runs the **real bash 5.3** compiled to wasm (emscripten) via
`src/realbash.js` → `runRealBash(script, { hostRun })`. The binary lives at
`www/wasm-bin/bash.wasm` (loader `www/vendor/bash.js`), built by
`build-wasm-bash.sh`.

## The problem: no fork

bash.wasm can't `fork()` (the syscall returns ENOSYS), so external commands
normally fail. Historically this was bridged with the shell's `web` builtin
(fire-and-forget host runs: output arrived after the script, `$?` was wrong).

## The fix: asyncify + a virtual spawn

`bash-wasm/bash-5.3/execute_cmd.c` (built with `-DBASH_WEB_SPAWN`) intercepts
top-level external commands — no pipeline, no async — *before* the fork:

```c
if (pipe_in == NO_PIPE && pipe_out == NO_PIPE && async == 0) {
  char **wargs = strvec_from_word_list (words, 0, 0, (int *)NULL);
  /* resolve the stdin redirect (< file / <<< here-string) */
  ...
  int s = bash_web_spawn (wargs, stdin_file, stdin_data);   /* EM_JS */
  if (s >= 0) { last_command_exit_value = s; return (s); }
}
```

`bash_web_spawn` is an `EM_JS` function wrapped in
`Asyncify.handleAsync()` — it **suspends the wasm** while
`globalThis.__bash_spawn(args, stdin, cwd)` runs the command in the host
shell, then **rewinds** with the exit status. Because the wasm is blocked
for the whole host run:

- output is in the right order (host output streams through bash's stdout)
- `$?` carries the real exit status (builtins + host commands mix fine)
- stdin redirects (`wc -l < f`) and here-strings (`sort <<< "b a c"`) are
  resolved in the C hook and handed to the host command
- bash's `PWD` is passed along so the host resolves relative paths against
  the script's cwd (with a fallback to the shell's cwd when bash started
  on a mount root — bash can't sit on a custom-FS mountpoint)

## Virtual-process port: pipelines + `$( )`

The fork sites are bridged too (same asyncify trick):

- **Pipelines** (`a | b | c`): `execute_pipeline` reconstructs the whole
  pipeline as one command line and runs it in the host shell, which has
  real pipes. Words are passed through raw (parse-time tokens — the host
  re-parses the identical shell syntax, so quotes, `$VAR`, escapes and
  `<<<`/`<`/`>`/`>>` redirects survive); the exit status is the last
  element's. `lastpipe` semantics are skipped (the last element runs in
  the host, not the current shell).
- **Command substitution** (`$(cmd)` / `` `cmd` ``): `command_substitute`
  runs the string in the host synchronously, writes the captured stdout
  into the substitution pipe, and feeds the parent read path. Nested
  `$( )` is pre-expanded bash-side (recursing through the same bridge)
  so the host never sees its own substitution. `$?`/`last_command_subst_status`
  carry the host status; `$(< file)` and other nofork optimizations are
  untouched (they never fork anyway).
- **`( )` subshells**: the subshell body (the inner command string via
  `make_command_string`) runs in the host shell — `( echo one; echo two )`,
  `(cd /home && pwd)` and even pipelines inside work. Subshell variable
  isolation is real (`x=5; ( x=7 ); echo $x` → 5).
- **Background `&`**: `cmd &` runs fire-and-forget in the host via the
  `web` builtin hook — bash moves on immediately, the command is queued
  and flushed **sequentially after** the bash run (a setImmediate would
  run concurrently with the next host spawn and the shell's nested
  runner is not reentrant — it hangs). `a & b` still runs `b`.
- `web <cmd>` remains the fire-and-forget fallback.

All three EM_JS hooks (spawn / capture / async) have the same asyncify
caveat: no complex C (free/dispose) after the call — the allocations are
deliberately leaked.

## The capture gotcha

The first `$( )` hook returned `(null)` on the C side even though the JS
had the output: the asyncify rewind **restores the wasm stack**, so the
EM_JS writing into a C stack local (`char *vout`) is lost. The capture
writes into a caller-allocated **heap** buffer (`xmalloc(1MB)`) instead —
heap memory survives the unwind/rewind.

## Asyncify gotchas (all solved here)

- **`callMain` breaks the unwind**: a manual `callMain` makes main re-run
  after the rewind. The build uses the runtime's auto-run
  (`noInitialRun: false`) with `arguments: ["/script.sh"]` and a `preRun`
  hook for FS/cwd/spawn setup.
- **Complex C after the rewind aborts**: `strvec_dispose` right after
  `bash_web_spawn` trips the instrumentation ("native code called
  abort()"). The argv string vector is deliberately leaked.
- **Stack size**: `-sASYNCIFY_STACK_SIZE=262144` (the default is too small
  for bash's deep call stack).
- **`exit N` detection**: `onExit` never fires while the asyncify runtime
  keeps itself alive — the completion marker
  (`echo __OTRANSPILER_EXIT_$?_`) covers normal completion, and the
  runtime's "program exited (with status: N)" notice covers `exit N`.

## The filesystem

`installVirtualFSMount` (src/realbash.js) mounts the shell's VirtualFS live
over `/tmp`, `/home`, `/usr/bin`, `/bin` (custom emscripten FS backend —
node_ops/stream_ops contract, writes go straight through `vfs.writeSync`).
Writes from bash builtins and reads by host commands share the same tree.

Custom-FS contract notes:

- `getattr` must return `atime/mtime/ctime` as `Date` objects (the C
  `writeStat` crashes on numbers).
- dirs must be `0o755` (the permission check on `chdir` needs `x`).
- the symlink/readlink node_ops exist (the runtime symlinks
  `/dev/stdin → /dev/tty` at init) — `/dev` is pre-created as a dummy.
- bash can't start with its cwd ON a mount root (it exits silently or
  getcwd fails) — start at `/` and fall back to the shell cwd for host
  commands; subdir cwds (e.g. `/home/work`) work fine.
