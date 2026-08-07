# Vendored go source frontends — the unified otranspiler fleet

These directories are the **source** of the go frontends the `otranspiler`
command builds on first use (one unified binary, see `/bin/otranspiler.js`):

| dir          | frontend          | source lang → A1 shIR |
|--------------|-------------------|------------------------|
| `go-sh/`     | golib             | Go → shIR (self-hosting path) |
| `py-sh-go/`  | pylib             | Python → shIR |
| `c-sh-go/`   | clib              | C → shIR |
| `perl-sh-go/`| pllib             | Perl → shIR |
| `zsh-sh-go/` | zshlib            | Zsh → shIR |
| `fish-sh-go/`| fishlib           | Fish → shIR |
| `shir-emit-go/` | shiremit       | the shared A1 JSON emitter (the contract's single source of truth) |
| `busybox/`   | —                 | the unified CLI: one binary over all six libs (`--lang <lang> --shir <file> [--raw]`) |

The browser go toolchain builds a **single stdlib-only main.go**: the
`otranspiler` command merges all six libs + `shir-emit-go` + the busybox
CLI into one file (package/import lines stripped, imports unioned,
cross-package references unqualified, per-part name prefixes so no
identifiers collide — the merge mirrors the upstream layout), then
`go build`s it once and caches the wasm in `/tmp/otranspiler-busybox/`.
One artifact, one Go runtime, one build — the browser port of the
sh2loop fleet's own unified-binary answer.

## Sync

These are vendored from [gmatht/sh2loop](https://github.com/gmatht/sh2loop)
`frontends/` (which is the source of truth — the worker loops commit there).
To refresh a frontend:

```sh
cp /path/to/sh2loop/frontends/<dir>/<file>.go www/bin/<dir>/
```

The command only rebuilds when the merged source changes (it compares the
cached main.go), so a refresh is picked up automatically on next use.
