# Licences & Provenance Audit

This document records every third-party component shipped by **j.cmd / sh2runtime**
(the browser shell), its licence, its source repository, and the compliance
status of our use. It was written to audit that the project satisfies the
licence requirements of everything it distributes — the vendored WASM
binaries, JS glue, npm dependencies, and the compiled toolchains built from
source.

License texts are kept alongside this file in `docs/licenses/`.

## The project itself

- **j.cmd / sh2runtime** — `LICENSE.md` at the repo root — **GPL-3.0**,
  "same as sh2perl" (the companion project in the same ecosystem,
  `gmatht/sh2perl`). GPL-3.0 requires distributing the license text with
  the work; `LICENSE.md` provides it.

## Published forks

The code we **clone, patch and rebuild** from other projects is published as
GitHub forks under `gmatht/` so the provenance and our modifications are
traceable, and the build scripts in this repo clone from those forks.

| Our fork | Upstream | Licence | What we ship | Our changes |
|---|---|---|---|---|
| [gmatht/busybox](https://github.com/gmatht/busybox) | busybox (canonical: git.busybox.net/busybox; GitHub mirror: mirror/busybox) | **GPL-2.0** | `www/wasm-bin/grep.wasm` | minimal grep build: stubs + Kbuild edits in `build-wasm-grep.sh` |
| [gmatht/markdown-wasm](https://github.com/gmatht/markdown-wasm) | [rsms/markdown-wasm](https://github.com/rsms/markdown-wasm) | **MIT** | `www/wasm-bin/markdown.wasm` | build flags only (`build-wasm-markdown.sh`) |
| [gmatht/zstd](https://github.com/gmatht/zstd) | [facebook/zstd](https://github.com/facebook/zstd) | **BSD-3-Clause** (also licensed GPL-2.0) | `www/wasm-bin/zstd.wasm` | build flags only (`build-wasm-zstd.sh`) |
| [gmatht/NetHack](https://github.com/gmatht/NetHack) | [apowers313/NetHack](https://github.com/apowers313/NetHack) (branch `wasm-3.6.7`) | **NetHack licence** (custom copyleft, see `docs/licenses/NETHACK-LICENSE.txt`) | `www/vendor/nethack.{js,wasm}` via the prebuilt npm package | none (prebuilt from the fork's build) |
| [gmatht/cproc](https://github.com/gmatht/cproc) | [michaelforney/cproc](https://github.com/michaelforney/cproc) | **ISC** | `www/wasm-bin/cproc.wasm` (the `cc` C compiler) | wasm32-wasi build: configure target, driver spawn stubs, wasm64 target (`build-wasm-cproc.sh`) |
| [gmatht/tinycc-wasm](https://github.com/gmatht/tinycc-wasm) (build tree `tinycc-wasm/`) | [TinyCC/tinycc](https://github.com/TinyCC/tinycc) | **LGPL-2.1** (`docs/licenses/TCC-LICENSE.txt`) | `www/wasm-bin/tcc.wasm` (the `tcc` C compiler) | wasm32-wasi build with the wasm32 backend (in-tree since TinyCC 0.9.28rc): `./configure --target=wasm32-wasi`-style, `make` → `tcc` (see `build-wasm-tcc.sh` for the recipe) |
| [gmatht/neth4ck-monorepo](https://github.com/gmatht/neth4ck-monorepo) | [apowers313/neth4ck-monorepo](https://github.com/apowers313/neth4ck-monorepo) | NetHack licence / package MIT | source of `@neth4ck/wasm-367` → nethack.wasm | none |

## Prebuilt / unmodified components

Shipped as-is from upstream builds or npm; no fork is needed (we modify
nothing), but the licences are recorded and the notices preserved.

| Component | Ships as | Source | Licence |
|---|---|---|---|
| Go toolchain (cmd/compile, cmd/link, js_wasm stdlib) | `www/wasm-bin/go.wasm`, `link.wasm`, `goroot.dat` | [golang/go](https://go.dev) | **BSD-3-Clause** (`docs/licenses/GO-LICENSE.txt`) |
| Go's js/wasm runtime glue | `www/vendor/wasm_exec.js` | golang/go `misc/wasm/` | **BSD-3-Clause** |
| MicroPython | `www/wasm-bin/python.wasm`, `www/vendor/micropython.{js,wasm}` | [micropython/micropython](https://github.com/micropython/micropython) + [yeliulee/micropython-wasm](https://github.com/yeliulee/micropython-wasm) | **MIT** |
| @wasmer/wasi + @wasmer/wasmfs (WASI runtime) | `www/vendor/wasmer-wasi.mjs`, `wasmer-wasmfs.mjs` | [wasmerio/wasmer-js](https://github.com/wasmerio/wasmer-js) | **MIT** |
| zeroperl | `www/vendor/zeroperl.{mjs,wasm}` | [6over3/zeroperl-ts](https://github.com/6over3/zeroperl-ts) | **Apache-2.0** (declared in package.json) |
| xterm.js + addon-fit | `www/vendor/xterm.{js,css}`, `xterm-fit.js` | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) | **MIT** |
| pako (zlib) | `www/vendor/pako.min.js` | [nodeca/pako](https://github.com/nodeca/pako) | **MIT** (`docs/licenses/PAKO-LICENSE.txt`) |
| StreamSaver | `www/vendor/streamsaver.js` | [jimmywarting/StreamSaver.js](https://github.com/jimmywarting/StreamSaver.js) | **MIT** |
| wasmoon (Lua) | `www/vendor/wasmoon.{mjs,wasm}` | [ceifa/wasmoon](https://github.com/ceifa/wasmoon) | **MIT** |
| wabt | npm dependency | [WebAssembly/wabt](https://github.com/WebAssembly/wabt) | **Apache-2.0** |
| wasm-diff | `www/wasm-bin/wasm-diff.wasm` | [jlricon/wasm-diff](https://github.com/jlricon/wasm-diff) | **MIT OR Apache-2.0** |
| cproc (the `cc` compiler) | `www/wasm-bin/cproc.wasm` | [michaelforney/cproc](https://github.com/michaelforney/cproc) (fork: gmatht/cproc) | **ISC** (`docs/licenses/CPROC-LICENSE.txt`) |
| tcc (the `tcc` compiler) | `www/wasm-bin/tcc.wasm` | [TinyCC/tinycc](https://github.com/TinyCC/tinycc) (build tree: gmatht/tinycc-wasm) | **LGPL-2.1** (`docs/licenses/TCC-LICENSE.txt`) |
| debashcl (the `bash` toolchain) | `www/wasm-bin/debashcl.wasm` | [gmatht/sh2perl](https://github.com/gmatht/sh2perl) (vendored reactor build, see `vendor/sh2/`) | **GPL-3.0** (own project) |
| Demo binaries | `www/wasm-bin/echo.wasm`, `echoc.wasm` | this repo | GPL-3.0 (project's own) |
| make | `www/wasm-bin/make.wasm` | 39-byte placeholder stub | GPL-3.0 (project's own) |

## Audit findings

1. ✅ **RESOLVED — `steinerkelvin/c-to-wasm-compiler-project` (no licence
   file) removed.** `compiler.wasm` was built from that upstream, which had
   no licence ("all rights reserved"). It is no longer shipped, installed
   or referenced: `www/wasm-bin/compiler.wasm`, `build-wasm-compiler.sh`,
   `wasm-compiler.patch` and the wasmer `compiler`/`cc` registry entries
   are gone, and the `cc` / `compiler` commands now run **cproc (ISC)** →
   QBE IR → qbe2wasm, with **tcc (LGPL-2.1)** also available. No
   permission from the upstream author is needed for anything we ship.

2. ✅ **GPL obligations are met where they arise.** `grep.wasm` (busybox,
   GPL-2.0): the full source (busybox with our build configuration) is
   obtainable from the fork + `build-wasm-grep.sh`, and the licence text
   is included. The project itself is GPL-3.0 with `LICENSE.md`.

3. ✅ **NetHack licence** (custom copyleft, based on the Bison GPL): it
   requires that recipients can get the source and that notices stay
   intact. The source is the fork `gmatht/NetHack` (branch `wasm-3.6.7`);
   `docs/licenses/NETHACK-LICENSE.txt` keeps the notice. We ship the
   unmodified build.

4. ✅ **MIT / BSD-3-Clause / Apache-2.0** components: the obligations are
   to include the copyright + licence notice with redistributed copies.
   The full texts live in `docs/licenses/`; unmodified vendored files keep
   their upstream headers (minified files such as `pako.min.js` strip the
   header — the notice is preserved here instead).

5. ✅ **Apache-2.0** (wabt, zeroperl): licence text included; no source
   modifications to state.

6. ✅ **Our own code** is GPL-3.0 with the licence text at the repo root.

## Where the texts live

Every licence text referenced above is committed under `docs/licenses/`:

```
docs/licenses/
  GO-LICENSE.txt              (BSD-3-Clause — Go)
  NETHACK-LICENSE.txt         (NetHack licence)
  ZSTD-LICENSE.txt            (BSD-3-Clause — Zstandard)
  MARKDOWN-WASM-LICENSE.txt   (MIT — markdown-wasm)
  CPROC-LICENSE.txt           (ISC — cproc, the cc compiler)
  TCC-LICENSE.txt             (LGPL-2.1 — TinyCC, the tcc compiler)
  PAKO-LICENSE.txt            (MIT — pako)
  SH2PERL-LICENSE.txt         (GPL-3.0 — sh2perl; also the project's own)
  NPM-@wasmer_wasi-LICENSE.txt    (MIT)
  NPM-@wasmer_wasmfs-LICENSE.txt  (MIT)
  NPM-@xterm_addon-fit-LICENSE.txt (MIT)
  NPM-streamsaver-LICENSE.txt     (MIT)
  NPM-wabt-LICENSE.txt            (Apache-2.0)
  NPM-wasm-diff-LICENSE.txt       (Apache-2.0; MIT variant also shipped)
  NPM-wasmoon-LICENSE.txt         (MIT)
  NPM-xterm-LICENSE.txt           (MIT)
  ZEROPERL-LICENSE.txt            (Apache-2.0, from npm metadata)
  MICROPYTHON-WASM-LICENSE.txt    (MIT, from npm metadata)
```

> The shell mounts this repo's `docs/` directory at `/docs`, so the audit
> is readable in-shell: `cat /docs/licences.md`.
