# Pseudorandom block textures in bash

Three self-contained bash scripts that pseudorandomly generate **wood**,
**grass** and **stone** block textures — Minecraft-style 16×16 tiles
(any multiple-of-8 size works), seamlessly tileable, fully
deterministic per seed.

```
texture-lib.sh       canonical shared core: seeded LCG, tileable value
                     noise, PPM writer, ANSI preview (reference —
                     every texture script below inlines it, so they all
                     run everywhere: host bash, real-bash wasm, jtsh)
texture-wood.sh      light-oak grain: stripes + per-column tone + knots
texture-grass.sh     meadow top: patches + blades + speckles
texture-stone.sh     granite: mottled noise + 3 crack segments + pebbles
texture-brick.sh     brick wall: 4px mortar grid, staggered joints,
                     per-brick jitter, burnt bricks
texture-leaves.sh    foliage canopy: clusters + dark undergrowth gaps
                     + sunlit flecks
texture-sandstone.sh sandstone: horizontal strata + bedding planes
texture-water.sh     water: diagonal wave bands + glints
texture-dirt.sh      dirt: clumps + pebbles + root flecks
make-textures.sh     one-shot: PPMs → PNGs → seam checks → contact sheet
                     (auto-discovers every texture-*.sh)
```

The scripts are **self-contained** (the shared core from
`texture-lib.sh` is inlined, no `source`): jtsh's transpiled bash runs
a sourced lib in a separate runtime where caller variables are
invisible, so inlining is what makes them work identically under host
bash, the real-bash wasm, and jtsh. `__texture-test.mjs` fails the
suite if they drift from `texture-lib.sh`.

## Usage

```bash
# PPM P6 on stdout — pipe straight into ImageMagick
bash texture-wood.sh > wood.ppm
bash texture-grass.sh > grass.ppm
bash texture-stone.sh > stone.ppm

# 256-color block preview right in the terminal
bash texture-wood.sh --preview

# PNG (needs ImageMagick convert)
bash texture-grass.sh --png

# size / seed
TEX_SIZE=32 TEX_SEED=7 bash texture-stone.sh > stone32.ppm

# everything at once (PNG + seam checks + contact sheet) — HOST bash
bash make-textures.sh            # or: bash make-textures.sh 7

# TSV (text, works everywhere incl. jtsh) — write to a writable dir
bash texture-wood.sh --tsv > /home/wood.tsv
bash read-texture.sh /home/wood.tsv            # shade preview from the TSV
bash make-textures.sh --tsv /home              # all 8 textures as .tsv
```

## The TSV format (for mimecroft.sh and friends)

`--tsv` emits pure text — no `printf -v`, no ImageMagick, so it works in
host bash AND jtsh's transpiled bash, and redirects to any writable
path (`/home`, `/tmp` — never `/examples`, which is read-only).

```
#texture<TAB>stone<TAB>16x16<TAB>seed<TAB>20240812<TAB>
60<TAB>60<TAB>65<TAB>85<TAB>85<TAB>90<TAB>…   ← 3 numbers per pixel
…                                             (R, G, B), 16 rows of
                                              trailing-tab + newline
```

Reading is deliberately transpiler-safe (`read-texture.sh` is the
reference): the transpiled shell's `${s#*TAB}` prefix-strip is greedy
and `${#s}`/IFS-splitting are broken, so fields are read with
`${s%%TAB*}` (text before the first tab) and consumed with a probe
loop of `${s#?}` char-strips. mimecroft-style:

```bash
# per pixel: read R, G, B (x = pixel % size, y = pixel / size)
read_field() { f=${s%%	*}; strip_field; }   # strip_field: probe loop
```

## How the randomness works

Everything is **integer arithmetic** — no floats, no `$RANDOM`:

- **Park–Miller LCG** (`rand`) places the structural features: knot
  positions, crack segments. Seeding is `TEX_SEED` (default
  `20240812`).
- **Value noise** (`vnoise2`): lattice points are hashed with a
  golden-ratio hash (`n*2654435761` folded through an XOR-shift and an
  odd multiplier), smoothstep-interpolated, with wrap-around on both
  axes — so every texture tiles seamlessly. (A plain `% 256` of a
  linear combination is linear mod 256 for any constants — it makes
  ordered ramps, not noise.)
- Per-column features (wood grain bands, grass blades) are pure
  functions of `x`, so they run straight down the texture and wrap
  horizontally. Per-pixel lattice hashes drive the speckles without
  touching the LCG stream.

Same seed → identical bytes. Different seed → different pattern.

## Running in jtsh (the repo's browser shell)

`www/examples/` is what jtsh mounts at `/examples`, so a synced copy of
these scripts lives at `www/examples/textures/` — same contents, kept
in lockstep by `__texture-test.mjs` (it fails the suite if they drift).

```
jtsh:/home$ cd /examples/textures
jtsh:/examples/textures$ bash texture-grass.sh --preview
jtsh:/examples/textures$ bash texture-wood.sh --preview
```

`--preview` works in jtsh: each pixel is a 256-color block (48;5) PLUS a
luminance shade glyph (`. :-=+*#%@`), so the texture stays visible even
in terminals that strip or ignore SGR color codes. The escapes are
`\x1b` so the transpiler.s JS template literals accept them — `\033`
is illegal there). PPM/PNG file output is host-bash territory: jtsh's
transpiled printf can't emit arbitrary bytes, so don't redirect the
raw script to a `.ppm` in the browser shell.

## sh2runtime compatibility

The scripts follow the same language discipline as
[`examples/mimecroft.sh`](../mimecroft.sh) — no `local`, no `$RANDOM`,
no C-style `for`, function args copied to prefixed names, `$(( ... ))`
never inlined inside test brackets — so the whole generation core
transpiles through `bash2js` (`src/bash2js.js`). The only host-side
bits are the `printf` I/O calls in `emit()`/`finish()`. See
`__texture-test.mjs` at the repo root for the transpile + run harness.

## Performance

16×16 (the default) generates in ~0.2–0.4 s per texture. Runtime grows
quadratically with the pixel count (64×64 ≈ 13–19 s), so render once
and reuse — that is what `make-textures.sh` does.
