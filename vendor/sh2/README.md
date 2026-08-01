# debashcl.wasm — debashc as a WASI library

`debashcl.wasm` is the full sh2perl command-line tool compiled to a WASI
**reactor** (library). It exposes the transpiler core (`debashl`) **and all
the command-line processing** (`main_with_args`: `file --estree`, `file
--perl`, `parse`, `lex`, `--help`, `-i/-o`, …) as plain C-ABI exports, so
an embedder can implement debashc in three lines of JavaScript:

```js
const { instance } = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi.wasiImport });
wasi.initialize(instance); // reactor init (node:wasi)
const res = instance.exports.debashc_cli_run(argc, argv); // → {"ok":true,"exit":0}
```

CLI output (ESTree JSON, generated Perl, AST dumps, help text, errors)
goes to the WASI stdout/stderr streams the embedder configured; the return
value is a small JSON envelope.

## Why this artifact exists

The sibling artifacts cover only half each:

| artifact | exports | gap |
|---|---|---|
| `debashc.wasm` (command) | `_start` | process entry only — no library call, and `node:wasi` has no filesystem preopens so `file` commands can't read files |
| `debashl.wasm` (library) | `debashc_to_perl` / `debashc_to_estree` | core transpiler only — no argv dispatch, no file reading, no help/options |
| **`debashcl.wasm`** (library) | `debashc_cli_run*` | **the full CLI as a library call** |

## Exports

| export | signature | purpose |
|---|---|---|
| `_initialize` | `()` | reactor entry (call once; `wasi.initialize(instance)` does it) |
| `debashc_cli_run` | `(argc: u32, argv: ptr) → ptr` | run the full CLI with an argv array (`argv[0]` = program name, e.g. `"debashc"`) |
| `debashc_cli_run_json` | `(input: ptr, len: u32) → ptr` | same, argv as a JSON array string (`["debashc","file","--estree","x.sh"]`) |
| `debashc_cli_run_with_input` | `(argc, argv, input: ptr, len: u32) → ptr` | same as `debashc_cli_run` but file commands read the script bytes from `input` — use filename `-` (`["debashc","file","--estree","-"]`); no filesystem preopens needed |
| `debashc_alloc` | `(len: u32) → ptr` | reserve a `len`-byte payload buffer for inputs (argv strings, JSON, script content) |
| `debashc_str_len` | `(ptr) → u32` | payload byte length of a returned/allocated buffer |
| `debashc_free` | `(ptr)` | release a buffer (one path for allocations and results) |

All `ptr` results are NUL-terminated UTF-8 buffers laid out as
`[u32 len LE][data][0]`; the returned pointer points at `data`
(`debashc_str_len` reads the length at `ptr-4`, `debashc_free` releases the
whole buffer).

## Quick start (Node ≥ 20, `node:wasi`)

```bash
node example-wasi.mjs parse 'echo hi'      # string-input commands work everywhere
node example-wasi.mjs --version
node example-wasi-file.mjs my.sh --estree  # file commands: node reads my.sh, passes bytes
node example-wasi-file.mjs my.sh --perl
```

`example-wasi.mjs` shows the argv marshalling for `debashc_cli_run`;
`example-wasi-file.mjs` shows `debashc_cli_run_with_input` for
`file --estree` / `file --perl`.

### Minimal `file --estree` in one gulp (ESM)

```js
import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';

const script = process.argv[2];
const content = await readFile(script);               // node's fs, not the wasm's
const wasi  = new WASI({ version: 'preview1', args: ['debashc'] });
const { instance } = await WebAssembly.instantiate(
  await readFile('./debashcl.wasm'), { wasi_snapshot_preview1: wasi.wasiImport });
wasi.initialize(instance);

const enc = new TextEncoder();
const argv = ['debashc', 'file', '--estree', '-'];    // '-' = stdin = the bytes we pass
const ptrs = [];
for (const a of argv) {
  const b = enc.encode(a);
  const p = instance.exports.debashc_alloc(b.length);
  new Uint8Array(instance.exports.memory.buffer, p, b.length).set(b);
  ptrs.push(p);
}
const table = instance.exports.debashc_alloc(4 * argv.length);
new Uint32Array(instance.exports.memory.buffer, table, argv.length).set(ptrs);
const pIn = instance.exports.debashc_alloc(content.length);
new Uint8Array(instance.exports.memory.buffer, pIn, content.length).set(content);

// ESTree JSON on stdout, {"ok":true,"exit":0} as the return envelope
instance.exports.debashc_cli_run_with_input(argv.length, table, pIn, content.length);
```

## Platform notes

- **`node:wasi` (preview1) has no filesystem preopens.** File commands need
  `debashc_cli_run_with_input` (above) or an embedder with preopens
  (wasmtime/wasmer `--dir .`).
- **No fork/exec in WASI preview1**: commands that run the generated Perl
  at the end (`file` without `--perl`/`--estree`, `-i` without `-o`)
  degrade to print-only. The transpile commands (`file --estree`, `file
  --perl`, `parse`, `lex`, `--help`, `--version`) are unaffected.
- Error paths that call `process::exit(1)` terminate the wasm instance via
  `proc_exit` (embedder sees a nonzero exit).

## Rebuilding

From the sh2perl repo (`sh2perl/`):

```bash
./build-wasi.sh   # builds debashc.wasm + debashl.wasm + debashcl.wasm
cp target/wasm32-wasip1/release/debashcl.wasm ~/js/
```

Source: `cli/src/wasi_api.rs` (the CLI-layer ABI), `cli/src/lib.rs`
(virtual stdin), `cli/src/cli_commands.rs` (`-` stdin convention).
Deployed from sh2perl commit `40af977`.
