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
│  tinysh — minimal shell                  │
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

## tinysh — The Minimal Shell

tinysh is to the virtual filesystem what `/bin/sh` is to a Unix kernel.
It reads lines, splits on spaces, and runs the matching command.

```
$ node src/tinysh.js
tinysh:/home$ ls
hello.txt
tinysh:/home$ cat hello.txt
Hello from the virtual filesystem!
tinysh:/home$ sayhello
Hello, world!
tinysh:/home$ counter
Invocation #1
tinysh:/home$ counter
Invocation #2
tinysh:/home$ help
```

### Running .js Files as Commands

Any command that isn't a builtin is looked up as a `.js` file in the
virtual filesystem's command path (`/bin/`, `/usr/bin/`).

These are the "compiled binaries" of this architecture:

```
tinysh:/home$ echo "console.log(args[0])" > /bin/echo.js
tinysh:/home$ echo hello
hello
```

### In the Browser

```
cd /root/src/sh2runtime
python3 www/serve.py
# → http://localhost:8080/www/
```

Live site: **https://gmatht.github.io/j.cmd/** — a GitHub Actions
workflow (`.github/workflows/pages.yml`) assembles `www/*` + `src/`
and deploys them as the site root.

Use `serve.py` (not bare `http.server`) — it sets COOP/COEP headers
(required for SharedArrayBuffer, used by the WASI Python REPL) and
no-cache headers (stale files cause confusing bugs while developing).

Same runtime as the Node CLI, but the terminal is a DOM-based shell
where you type directly on the prompt line, inline in the scrollback
— like a real terminal emulator.
No build step, no bundler — just ES modules served over HTTP.

## The Plan 9 Connection

This follows Plan 9's philosophy: **everything is a file**.

| Traditional | Here |
|---|---|
| `/bin/sh` | `tinysh` |
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

GPL-3.0 (same as sh2perl)
