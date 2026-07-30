# sh2perl-runtime

**JavaScript is the "binary format"** of the browser-shell architecture.
This runtime is the "machine code layer" — the virtual filesystem that
compiled shell scripts run against.

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

- **RAMFS**: In-memory filesystem at `/tmp/`, `/home/`
- **HttpFS**: Read-only fetch-backed filesystem at `/http/` (for CORS APIs)
- **More to come**: localStorage, WebGL, GitHub, clipboard, terminal

## tinysh — The Minimal Shell

tinysh is to the virtual filesystem what `/bin/sh` is to a Unix kernel.
It reads lines, splits on spaces, and runs the matching command.

```
$ node src/tinysh.js
tinysh:/home$ ls
hello.txt
tinysh:/home$ cat hello.txt
Hello from the virtual filesystem!
tinysh:/home$ echo hello world
hello world
tinysh:/home$ pwd
/home
tinysh:/home$ cd /tmp
tinysh:/tmp$ ls
README
tinysh:/tmp$ cat README
This is ramfs. Contents lost on reload.
tinysh:/tmp$ help
```

### Running .js Files as Commands

Any command that isn't a builtin is looked up as a `.js` file in the
virtual filesystem's command path (`/commands/`, `/usr/bin/`, `/bin/`).

These are the "compiled binaries" of this architecture:

```
tinysh:/home$ echo "console.log('args:', args)" > /tmp/printargs.js
tinysh:/home$ /tmp/printargs.js one two three
args: [ 'one', 'two', 'three' ]
```

The runtime provides `args` (command arguments as an array), `fs`
(the virtual filesystem), and `console` (with captured `.log()` output)
to every executed `.js` file.

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

## License

GPL-3.0 (same as sh2perl)
