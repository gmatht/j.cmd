# sh2runtime

**JavaScript is the "binary format"** of the browser-shell architecture.
This runtime is the "machine code layer" — the virtual filesystem that
compiled shell scripts run against.

This is the JavaScript runtime for the [sh2perl](https://github.com/gmatht/sh2perl)
transpiler ecosystem. Shell scripts compiled by sh2perl produce JavaScript
that imports this library and calls its virtual filesystem API.

## Architecture

```
┌──────────────────────────────────────────┐
│  jtsh — minimal shell                  │
│  (splits input on spaces, runs commands) │
│         │                                │
│         ▼                                │
│  Virtual Filesystem (this library)       │
│         │                                │
│  ┌──────┼──────┐                         │
│  ▼      ▼      ▼                         │
│ RamFS  HttpFS  ... (more backends)       │
│ /tmp/  /http/                            │
└──────────────────────────────────────────┘
```

- **RamFS**: In-memory filesystem at `/tmp/`, `/usr/bin/` (WASM tools)
- **LocalStorageFS**: Persistent user files at `/home/`, `.js` commands at `/bin/`
- **HttpFS**: Read-only fetch-backed filesystem at `/http/` (for CORS APIs)
- **More to come**: localStorage, IndexedDB, WebGL, GitHub API, clipboard

## jtsh — The Minimal Shell

jtsh is to the virtual filesystem what `/bin/sh` is to a Unix kernel.
It reads lines, splits on spaces, and runs the matching command.

```
$ node src/jtsh.js
jtsh:/home$ ls
hello.txt
jtsh:/home$ cat hello.txt
Hello from the virtual filesystem!
jtsh:/home$ sayhello
Hello, world!
jtsh:/home$ counter
Invocation #1
jtsh:/home$ counter
Invocation #2
jtsh:/home$ help
```

### Running .js Files as Commands

Any command that isn't a builtin is looked up as a `.js` file in the
virtual filesystem's command path (`/bin/`, `/usr/bin/`).

These are the "compiled binaries" of this architecture:

```
jtsh:/home$ echo "console.log(args[0])" > /bin/echo.js
jtsh:/home$ echo hello
hello
```

### In the Browser

```
cd /root/src/sh2runtime
python3 www/serve.py
# → http://localhost:8080/www/
```

Live site: **https://gmatht.github.io/j.cmd/www/** — a GitHub Actions
workflow (`.github/workflows/pages.yml`) publishes `www/` and `src/`
as siblings (the shell imports `../src/`, so the app lives at the
`/www/` path; a bare root would break those imports).

Use `serve.py` (not bare `http.server`) — it sets COOP/COEP headers
(required for SharedArrayBuffer, used by the WASI Python REPL) and
no-cache headers (stale files cause confusing bugs while developing).

Same runtime as the Node CLI, but the terminal is a DOM-based shell
where you type directly on the prompt line, inline in the scrollback
— like a real terminal emulator.
No build step, no bundler — just ES modules served over HTTP.

## NetHack — the Real Game as WASM

`nethack` runs the **actual NetHack 3.6.7** (the 1982 roguelike) in the
browser: the C game compiled to WASM with emscripten (apowers313/
NetHackJS → the neth4ck monorepo), driven through its win/shim window
system with Asyncify. The shell renders it as a TTY — status line, the
dungeon map with colours, messages — and feeds keys straight to the
game. ESC q quits like a real terminal; Ctrl+C returns to the shell.

```
nethack             # browser: full-screen game
nethack --demo      # CLI: scripted autoplay (proves the pipeline)
```

Assets are `www/vendor/nethack.{js,wasm}` (wasm is 4.9MB, game data
embedded); `build-wasm-nethack.sh` fetches them from the npm package.

## Async Commands — Type Ahead While They Run

Non-interactive commands (`echo`, `ls`, `grep`, `sleep`, `go build`, …)
now run as **tasks**: the prompt returns within ~100ms with a busy
suffix — a spinner plus the red count of unfinished jobs (the task
itself plus any `&` background jobs) — and you can keep typing while
they complete. Their output appears when they finish. Commands that
change shell state (`cd`, `export`, `mount`, …) or take over the
terminal (`vi`, `nethack`, the Python/Perl/Bash REPLs, pagers) still
run to completion before the next prompt, as before. `Ctrl+C` aborts
all running tasks; `wait` waits for them too.

## C in the Browser — the Real Compiler (cproc)

`cc` now runs the **real C compiler**: cproc (Michael Forney's C
compiler, built to wasm32-wasi) parses C and emits QBE IR, which the
in-shell `qbe2wasm` backend translates into a wasm binary — the whole
gcc-style pipeline in the browser, no server:

```
cc hello.c && ./a.wasm
```

libc calls (printf/puts/malloc/string/memory functions) resolve to the
shell's C runtime (`src/c-runtime.js`); the preprocessor is minimal
(`#include`/`#define` lines are stripped and the libc declarations are
injected). `cc -S` shows the QBE IR. Build: `build-wasm-cproc.sh`
(fork: gmatht/cproc).

## Filing a Bug Report — the `bug` Command

`bug` files a report against this shell as a **GitHub issue** on
`gmatht/j.cmd` (label: `bug-report`), carrying the terminal context so
nobody has to ask "what happened?".

```
jtsh:/home$ bug "cc says 'undefined data symbol'"
── bug report · last 20 lines of the terminal ──
...
```

In the browser it opens a single selection form: the terminal scrollback
with three markers — **▲** top of the snippet, **●** the line to use as
the title, **▼** bottom of the snippet. Left/right arrows pick the
marker, up/down move it, Enter files the report, Esc cancels. There are
no follow-up prompts — the report goes out as-is, and the GitHub form
lets you add more detail later (probably not required: if it's broken
it's probably obviously and completely broken — and don't worry about
duplicates).

Posting is token-free by default: unless you've saved a token
(`bug --token <PAT>`, https://github.com/settings/tokens,
`repo`/`public_repo` scope), the shell opens a **prefilled GitHub web
form** — title and body already filled in — that you review and submit
in your own GitHub session, so no token ever sits in this shell (handy
on an experimental OS). Either way the report is also saved to
`/tmp/bug-report.md` and copied to the clipboard.

The CLI form is non-interactive (snippet = the last 20 lines of
terminal output):

```
$ node src/jtsh.js
jtsh:/home$ bug --expect "it should print 55" "fib printed nothing"
jtsh:/home$ bug --dry-run "preview the report without posting"
jtsh:/home$ bug --webform "print the prefilled GitHub form URL"
```

The token comes from `$JTSH_GITHUB_TOKEN` or `~/.jtsh-gh-token`
(`bug --token <PAT>` saves one).

To triage reports on the repo side:

```
./bug-triage.sh            # list open reports (number · date · title)
./bug-triage.sh show 12    # full report
./bug-triage.sh pick       # walk each report, then choose numbers to fix
```

## Background Jobs (&) — the Right-Hand Panel

`cmd &` runs a pipeline in the background. `jobs` / `wait [id]` /
`kill <id>` control them (man jobs/wait/kill). In the browser, the
right **quarter of the display** is the background-jobs panel: each
non-minimized job gets an equal vertical slice with its own title bar
— **minimise** (—) collapses it to a thin dock row, **kill** (✕)
terminates a running job (exit 137) or dismisses a finished one.
Output streams into the job's slice while it runs, so the terminal
stays clean.

## Go in the Browser — the Real Toolchain as WASM

The `go` command runs the **real Go compiler and linker** — cmd/compile
(37MB) and cmd/link (8.9MB), cross-compiled with `GOOS=js GOARCH=wasm`
— inside the shell (see `build-wasm-go.sh`):

```
go run main.go [args...]     # compile + link + run, in the browser
./main.wasm                  # js/wasm binaries run as commands too
go build main.go             # leaves main.wasm in the shell
```

How it works: Go's js/wasm runtime (`wasm_exec.js`, vendored) calls a
node-fs-style `globalThis.fs` — we back it with the shell's VirtualFS
— and a `globalThis.process` whose `argv0` isn't node, so `net/http`
takes the browser path and maps to the **fetch API** (CORS applies,
exactly as in Go's js/wasm docs). The stdlib needed to resolve imports
is shipped as one gzipped bundle (`www/wasm-bin/goroot.dat`,
~11MB) and served out of memory. cmd/go itself can't run on js/wasm
(no os/exec), so the shell command drives compile → link directly.

## The Plan 9 Connection

This follows Plan 9's philosophy: **everything is a file**.

| Traditional | Here |
|---|---|
| `/bin/sh` | `jtsh` |
| ELF binaries | `.js` files |
| `/dev/sd0` (disk) | `/home/` (localStorage) |
| `/dev/ip` (network) | `/http/` (fetch) |
| `/proc/` | browser `navigator.*` APIs |
| 9P2000 protocol | `VirtualFS` interface |

## Security

A full description of the security model — users, permissions, the
custom-code execution gate, admin-only mount/chroot, and the
LLM-key / localStorage / CORS story — lives in
[docs/security.md](docs/security.md). The short version: permissions are
enforced at the filesystem layer, unprivileged users can't run custom
code, and browser API keys are protected from other websites (Same-Origin
Policy) and from page visitors (per-client localStorage) but not from the
page's own code — keep keys personal or proxy them server-side.

## License

GPL-3.0 (same as sh2perl) — see `LICENSE.md`.

The shell ships third-party components (WASM toolchains, interpreters,
libraries). Their licences, source repositories and the compliance audit
live in **`docs/licences.md`** (license texts in `docs/licenses/`), and are
readable in-shell: `cat /docs/licences.md`. Code we patch and rebuild from
other projects is published as GitHub forks under
github.com/gmatht — see the audit for the fork list.
