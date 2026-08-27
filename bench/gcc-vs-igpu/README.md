# GCC C vs iGPU — the comparison harness

Runs the **same problems** two ways and compares them in a webpage:

1. **CPU**: a HANDWRITTEN C reference, compiled with `gcc -O2`, run at a
   **fixed size** per problem (collatz 100M, ca1d 1B, hash 1B — the `BASE_N`
   constants in `run.mjs`). No calibration to a wall time, so the comparison
   is reproducible and the speedup is not inflated at small N / deflated at
   large N.
2. **iGPU**: the same problem at the same size, run in a real browser through
   the sh2runtime WebGL path, driven automatically by Playwright.

The page (`www/gcc-vs-igpu.html`) renders the comparison: C (GCC) vs iGPU
wall time, the **per-item cost** (`ns/item`) for each side, the speedup, and
a mod-2³² checksum that must match the C binary's output — that checksum
agreement is the correctness gate.

## What the numbers mean

The table shows, per problem:

- **C ms / iGPU ms** — wall time for the handwritten C reference and the
  WebGL block-reduction (one draw, `N/BLOCK` readback), best of 2.
- **ns/it** — per-item cost = `ms × 1e6 / N`. This is the **size-independent**
  efficiency: it strips out the absolute size and the GPU's fixed overhead.
- **speedup** = `C_ms / iGPU_ms`. Because both sides run at the **same fixed
  N**, this equals `C_ns/it ÷ iGPU_ns/it` — the per-item speedup *is* the
  wall speedup. Report the per-item rates when comparing across machines;
  report the wall speedup when comparing at the fixed N.

> The old harness calibrated N so the C run hit a target wall time. That made
> the speedup size-dependent (a fixed C budget ÷ a growing GPU time), so it
> looked like 100×+ at small N and ~12× at large N. Fixed N removes that
> artifact; the per-item rates are the honest figure.

## Why the GPU side is fast (block reduction)

The first version read back **every result** (one pixel per item) — for the
10-60 s C sizes that is gigabytes of `readPixels` plus hundreds of millions
of JS ops, which froze the browser. The GPU side now uses a **block
reduction**: each shader invocation processes `BLOCK` items (default 1024)
and outputs the *partial checksum* (RGBA-packed), so the readback is
`N/BLOCK` values and the whole problem is **one draw**. The inputs are
computed in-shader from the global index (32-bit-safe modular forms of the
same formulas the C uses), so no texture upload is needed.

## Transpiler pre-passes: `while`, bit ops, and branchless on WebGL1

The sh→GLSL backend (`otranspilerl_shir_opt`, a prebuilt WASM) only supports
fixed-count `for x in LIST` loops and has **no bit ops** under WebGL1 / GLSL
ES 1.00. It also *parses* but then **drops** `while`/`until` (it can't lower
them) and GLSL ES 1.00 rejects the real bit operators at compile time. Three
JS pre-passes in `c-programs.mjs` bridge that gap so callers can write a plain
`while` (and the common bit ops) and still target WebGL1:

- **`lowerWhileLoops(src)`** — rewrites `while`/`until COND; do BODY; done`
  into `for __wN in 0..M; do if COND; then BODY; fi; done`. The `if COND`
  guard gives the early exit a `while` would normally provide; the fixed upper
  bound `M` (OUTER_MAX / INNER_MAX) guarantees termination and bounds GPU
  time. `until C` is `while !C`, but since the backend can't emit `!` in a
  test it flips the comparison operator instead (`-eq`↔`-ne`, `-gt`↔`-le`, …).
  `break`/`continue` are not supported — write the loop so the condition guard
  does the exiting.
- **`lowerBitOps(src)`** — emulates the bit ops GLSL ES 1.00 lacks for the
  common cases that map to integer arithmetic the backend already supports:
  `a >> K` → `a / 2^K`, `a << K` → `a * 2^K`, and `a & (2^K−1)` → `a % 2^K`
  (constant `K` only). General `&`/`|`/`^`/`~` and *variable* shifts are left
  untouched (the backend then flags them) — those genuinely need WebGL2.
- **`lowerBranchless(src)`** — automatically rewrites the NAIVE branchy form
  `while [ $X -gt 1 ]; do if [ $(( X % 2 )) -eq 0 ]; then X=$(( A )); S=$(( S + 1 )); else X=$(( B )); S=$(( S + 1 )); fi; done`
  into the branchless parity-select + active-mask form (no `if` in the hot
  path, zero warp divergence). The select goes through a temp variable (the
  backend can't parse deeply-nested expressions). `opts.maxIter` bounds the
  fixed loop (default 128 — the max collatz steps for seed ≤ 250).
  Generalised beyond the collatz pattern: any `while`/`until` comparison
  condition (`-gt`/`-lt`/`-ge`/`-le`/`-eq`/`-ne`), any `if` comparison
  condition (not just parity), single-branch `if`s (no `else`), variables
  assigned in one or both branches, and plain assignments (`mix=127`).
  `selectIfElse(src)` is the standalone if/else→select half (for straight-line
  shaders with no `while`).

All three are applied automatically by the page and `verify-gpu.mjs` (wrapped
as `lowerBitOps(lowerWhileLoops(lowerBranchless(shader(TW, P, BLOCK))))`)
before `lib.raw`. They are no-ops for shaders that don't use those constructs.

> Note: the collatz shader is written in the NAIVE `while`+`if/else` form and
> `lowerBranchless` turns it into a SINGLE (non-nested) fixed loop — the
> `while`-lowered form (`lowerWhileLoops`) would nest a `for` inside the block
> `for`, which ANGLE/D3D11 mis-lowers (wrong checksums on the real iGPU).

## The problems (all defined once in `c-programs.mjs`)

| problem  | input (item i)                          | result                     |
|----------|-----------------------------------------|----------------------------|
| collatz  | value `(i*37+3)%251`                    | Collatz step count         |
| ca1d     | cell `(i*7+3)%2` (rule 118, edges clamp) | next-generation cell (0/1) |
| hash     | record `((i*53)%256,(i*89)%256,(i*127)%256)` | `(a*31+b*17+c*7)%256` |

The C source, the JS input generator, and the checksum accumulator live in
`c-programs.mjs` so the two sides cannot drift apart.

## Usage

```sh
# the real benchmark — headed browser, system iGPU, fixed sizes (collatz 100M,
# ca1d 1B, hash 1B)
node bench/gcc-vs-igpu/run.mjs

# SwiftShader (no display / CI) — software rasterizer, honest but slow
node bench/gcc-vs-igpu/run.mjs --headless

# 0.1x sizes for a fast smoke test (~1 min on SwiftShader)
node bench/gcc-vs-igpu/run.mjs --quick --headless

# override a size via the page URL ?collatz=...&ca1d=...&hash=...
# (or change BASE_N in run.mjs)

# GPU-only: fixed sizes, no C runs — quick GPU numbers on your machine
node bench/gcc-vs-igpu/run.mjs --gpu-only
```

## WSL2 + a real Windows iGPU

If you're in WSL2, the real GPU lives on the **Windows** side — the Linux
Chromium that the driver launches falls back to SwiftShader (WSLg's GL
passthrough isn't used by Chromium's WebGL). To get real iGPU numbers:

```sh
# 1. run the C side here (Linux gcc) — it writes the results and starts a
#    server, then prints a URL and waits
node bench/gcc-vs-igpu/run.mjs --c-only

# 2. open the printed URL in a WINDOWS browser (Edge/Chrome) — that browser
#    has the real Intel GPU (D3D11/ANGLE), runs the GPU side, and shows the
#    C-vs-iGPU comparison. Ctrl+C the WSL process when done.
```

WSL2 forwards localhost, so the Windows browser reaches the WSL server.

Exit code 0 = every GPU checksum matches the C binary; 1 = a mismatch.

## Outputs

- `www/gcc-vs-igpu-results.json` — the C side (sizes, times, checksums),
  written before the browser opens so the page can fetch it.
- `www/gcc-vs-igpu-comparison.json` — the collected page results
  (renderer, per-problem C/iGPU times, checksum verdict).
- The terminal table + the page's own table.

## Notes

- **32-bit index cap**: the GPU indexes items with a `highp int`, so N is
  capped at 2³¹. The fixed sizes (100M / 1B / 1B) are all safely below that.
- **hash is a fragment shader here**: the catalog's vertex POINTS transport
  is too fragile for the large-N benchmark on ANGLE (half-pixel point
  centres left gaps in the readback). The problem (the hash computation) is
  identical; the vertex path is exercised separately by the catalog bench
  (`www/gpu-catalog-bench.html`).
- The collatz block shader is **fully branchless** — the transpiler has no
  bit ops, so the even/odd branch and the "stop at n=1" guard are replaced
  with arithmetic selects: parity `e = n % 2` picks the step via
  `(1-e)*(n/2) + e*(3n+1)`, and `active = (n > 1)` masks the step once n
  reaches 1. Every thread runs the same 128 iterations (max steps for seed ≤
  250 is 127) with **zero warp divergence** — measured ~2.4-5× faster than the
  branchy ctz form on SwiftShader, and the divergence-free form wins by more
  on a real iGPU. (A `while`-lowered ctz form was tried first, but the nested
  `for`-in-`for` it produces mis-lowers on ANGLE/D3D11.)
- **Chunked draws (TDR safety)**: a single draw of the whole N (1B items for
  ca1d/hash) can exceed the D3D11 TDR budget (~2 s) on a weak iGPU and lose
  the WebGL context (`CONTEXT_LOST_WEBGL` → later draws are no-ops). The page
  and `verify-gpu.mjs` split N into ~51M-item sub-draws (`CHUNK_PX = 50000`
  pixels) and sum the partial checksums mod 2³²; each shader takes a
  `basePixels` offset and guards on the chunk's own pixel range, so chunk
  boundaries are exact (no overlap, no gap).
- `verify-gpu.mjs` is a headless-gl regression check that the page's GPU
  runners reproduce the C checksums (no browser needed).
