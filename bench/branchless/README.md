# Branchless-optimisation benchmark

Proves the `lowerBranchless` / `selectIfElse` pre-passes (in
`bench/gcc-vs-igpu/c-programs.mjs`) are **general** — not a collatz-specific
hack — by running several NAIVE branchy algorithms through them and checking
the auto-lowered shaders against a plain JS reference.

Each algorithm is written in the naive form (data-dependent `while`/`if`
conditions — the kind that cause warp divergence on a GPU) and covers a
different branch pattern:

| algorithm | branch pattern | pre-pass that fires | result |
|---|---|---|---|
| mandelbrot | `while \|z\|² ≤ 4` escape test (data-dependent termination) | `lowerBranchless` | transformed |
| maxreduce | `if v > max` per element (single-branch if in a for loop) | `selectIfElse` | transformed |
| threshold | `if v > 500` conditional count | `selectIfElse` | transformed |
| clamp | `if v < 0` / `if v > 255` (two single-branch clamps) | `selectIfElse` | **skipped (trivial)** |

## Degenerate-case detection (`skipTrivial`)

The clamp is the degenerate case: its branches are **constant assignments**
(`v=0`, `v=255`). The select `e*0 + (1-e)*v` is provably wasteful (the `e*0`
is always 0) and the branchy form is a single cheap op, so the transformation
would add more arithmetic than it saves on a scalar renderer. `selectIfElse`
detects this statically (a body assignment to a constant literal) and leaves
such branches branchy — the benchmark reports them as `skipped`. Variable-
assignment branches (`max=v`, `count+1`) are genuine selects and are still
transformed. Pass `{ skipTrivial: false }` to force the transformation anyway
(e.g. if you know the target GPU's divergence cost makes it worthwhile).

## What it checks

For each algorithm, at a fixed N (2M items, `--quick` = 0.1×):

1. **Correctness** — the NAIVE (branchy) form AND the auto-branchless form
   must both match the JS reference checksum. This is the point: the pre-passes
   rewrite *different* data-dependent branch structures into arithmetic selects
   with identical results.
2. **Speed (hint only)** — branchless vs branchy per-item cost on headless-gl
   (SwiftShader). SwiftShader is a scalar software renderer, so it measures
   arithmetic cost, not warp divergence — the real-GPU win (divergence
   elimination) is larger than these numbers show. Simple branches (clamp) can
   be neutral/slower, exactly as expected.

## Usage

```sh
node bench/branchless/run.mjs            # N=2M, headless (SwiftShader)
node bench/branchless/run.mjs --quick    # N=200K, fast smoke test
```

Exit code 0 = every algorithm matches the JS reference in both forms.
