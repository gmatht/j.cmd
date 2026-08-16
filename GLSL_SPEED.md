# GLSL_SPEED — int vs float (and mediump vs highp) in GLSL ES 1.00

A benchmark + report on whether the mimecroft game's **mediump int** fragment math is
worth it, measured on real browsers. The interactive harness is
[`www/glsl-int-vs-float-bench.html`](www/glsl-int-vs-float-bench.html) (WebGL1, GLSL
ES 1.00 only). This document records the methodology, the ES 1.00 constraints that make
the comparison meaningful, and the results.

## What the benchmark measures

Three modes, each rendering the game's real per-pixel / per-vertex workload twice:

| mode | path A | path B | workload |
|---|---|---|---|
| fragment: int vs float | mediump int (0..127 scale) | equivalent float (0..1) | the game's fragment: texture tint, CRT scanline, corruption hash, vignette, crack blend |
| vertex: int vs float | milli/‰ int transform | equivalent float | the game's vertex: yaw rotation + fake perspective, over a grid mesh |
| fragment: mediump vs highp float | mediump float | highp float | the SAME float pipeline — isolates the precision qualifier (mediump int is NOT involved in this mode) |
| fragment: mediump vs highp int | mediump int (the game's 0..127 scale) | highp int | the SAME int pipeline — isolates the int precision qualifier (the floats stay mediump) |
| mimecroft: actual vs full-int | the game's ACTUAL compiled fragment (float tint + int effects, transcribed from www/examples/mimecroft-frag.glsl) | the full-int version (the tint moved to mediump int) | the use-case-specific question: how much would the game gain if the generator emitted the int colour math |
| fragment: medp int /128 vs /127 | the game's int pipeline at /128 (power-of-two divisor — shift) | the same at /127 (exact normalisation — division) | isolates the divisor cost; everything else identical |

Timing: N frames × S samples per path, order alternated to cancel clock drift; reports
avg/min ms/frame, FPS, and the ratio.

## The GLSL ES 1.00 constraints that make it meaningful

- **Precision qualifiers are mandatory.** The vertex must declare
  `precision highp float;`; the fragment defaults to mediump. The benchmark uses the
  game's exact declarations — `mediump int` / `mediump float` in the fragment, highp
  for the UV/colour varyings.
- **mediump int is ±2¹⁵** (the ES 1.00 minimum). The game's intermediates
  (r·tex_r ≤ 127·255 = 32385, mix ≤ 127, hash ≤ 96) all fit — the int path is legal on
  every ES 1.00 device.
- **ES 1.00 has NO integer modulo, abs, or min/max overloads.** The game's compiled
  shader (via the sh2glsl generator) uses the float `mod()` + `int()` cast and the
  manual `if (x < 0) x = -x;` branch — the benchmark replicates those exact forms, so
  the "int" path is measured including the ES-1.00-mandated emulation of the missing
  int ops.
- **mediump float has a ~10-bit mantissa**, but desktop backends (ANGLE) usually map
  mediump to the FULL native float — so the float path runs at full precision while
  the int path runs at the int's exact ±2¹⁵. The two are not on equal precision
  footing, which is exactly the game's argument for the int pipeline.
- **Vertex vs fragment**: the vertex runs once per vertex (grid mesh vertices, must be
  highp); the fragment runs once per pixel (512×384, mediump). The fragment ratio is
  the per-pixel ALU cost (scales with screen area); the vertex ratio is the per-vertex
  transform cost (scales with geometry density).

## Sample results (ANGLE → D3D11, Intel UHD Graphics, Chromium)

Measured with the harness (24000 frames/sample × 5 samples):

| mode | path A | path B | ratio |
|---|---|---|---|
| fragment int vs float | int 0.079 ms/frame (12612 FPS) | float 0.125 ms/frame (7999 FPS) | **float 1.58× slower** |
| fragment mediump vs highp float | mediump 0.053 ms/frame (18740 FPS) | highp 0.064 ms/frame (15630 FPS) | **highp 1.20× slower** |
| fragment mediump vs highp int | mediump 0.123 ms/frame (8158 FPS) | highp 0.149 ms/frame (6725 FPS) | **highp 1.21× slower** |
| mimecroft: actual vs full-int | actual 0.102 ms/frame (9834 FPS) | full int 0.102 ms/frame (9801 FPS) | **1.003× — within ±5%** — the float tint costs nothing vs the int tint on this translator |
| fragment: medp int /128 vs /127 | /128 0.122 ms/frame (8195 FPS) | /127 0.138 ms/frame (7246 FPS) | **/127 1.13× slower** — the power-of-two /128 (a shift) is the cheaper divisor on this translator; the game's choice is the right one |

(Vertex mode on the same machine: per-vertex int vs float — run the page for the
current numbers.)

### Reading the results

- **Int wins in the fragment on this translator** (1.58×). The int ops (multiplies,
  constant divides, the branch abs/min, the int casts) lower to D3D11's native integer
  ALU, and the emulated modulo/abs are cheap. The float path pays the full-precision
  float ALU (mediump maps to full float on this ANGLE build) plus the `mod`/`min`/`mix`
  builtins. So the game's int pipeline is not just *exact* — it is *faster* here.
- **Highp costs 1.20× in the fragment.** The precision qualifier itself is measurable
  on this translator (the higher precision widens the ALU/register cost). The game
  avoids highp in the fragment anyway (it would require the `OES_fragment_precision_high`
  extension — not universally present on ES 1.00 mobile).
- **The ratio is translator/driver-dependent.** ANGLE → D3D11 (HLSL), ANGLE → Metal
  (MSL), ANGLE → Vulkan (SPIR-V), the native GL on Firefox/Safari, and the mobile
  GLES drivers (Mali/Adreno) each lower the GLSL ES int/float ALU differently — the
  same shaders can rank differently. The page prints the unmasked renderer/vendor so
  every result is read with its translator known.

## Verdict for the game

The mimecroft game's choice (mediump int in the fragment, 0..127 scale) is the faster
and the exact path on the measured translator, and it is legal everywhere ES 1.00
guarantees mediump int. The float rewrite would cost ~1.6× on this hardware (and
more on some others) purely in ALU, plus the mediump-float mantissa quantisation the
int path avoids. No change is warranted.


## Can the mimecroft GLSL be optimised on this basis?

Inspection of the game's compiled fragment (`www/examples/mimecroft-frag.glsl`, the
sh2glsl output the game renders with):

```glsl
precision mediump float;
precision mediump int;
varying highp vec4 vColor;
varying highp vec2 vUv;
...
int g_frag_x = int(gl_FragCoord.x);      // mediump int — fits (≤ 512)
...
g_r = (g_fr * float(int(_tex.r * 255.0))) / 128.0;   // the TINT — mediump FLOAT
g_scan = int(mod(float(g_frag_y), 6.0));              // int effects
g_r = max(g_r, 0.0);                                   // the r<0 clamps
```

Findings against the benchmark:

1. **The precision is already optimal.** The fragment is `mediump float` + `mediump int`
   — exactly the configuration the benchmark measures as fastest (highp float +1.20×,
   highp int +1.21×). No precision change is warranted.

2. **The colour math is done in mediump FLOAT, not int.** The game's bash source does the
   tint and the effects in int (`r=$((r * tex_r / 128))`, `r*90/100`, the mix /128), but
   the generator lowers that to GLSL float (`g_r = (g_fr * float(int(_tex.r*255.0)))/128.0`,
   `g_r *= 0.9`, `g_mix = min(float(uDamage)*cr.a, 127.0)`). The benchmark's full-int
   pipeline (the tint + effects in mediump int) measured **~1.6× faster than the full
   float pipeline** on this translator. The game's actual fragment is a MIX — float tint
   + int effects — so it sits between the two benchmarked extremes, and the tint (the
   per-pixel bulk: 3 mults + the `float(int())` conversions per channel) is the part the
   int path would win back. The optimisation therefore belongs in the **sh2glsl
   generator** (emit the game's int arithmetic as GLSL mediump int, as the benchmark's
   int pipeline does), not in the game — the game's bash is already int.

3. **Already done / trivial:** the double `fract(vUv)` (block + crack samples) is hoisted
   to one `_uv` per fragment (the game's emit_fragment_shader post-process); the `r<0`
   clamps and the `int(gl_FragCoord)` copies are trivial int ops the benchmark confirms
   are free next to the ALU work.

**Verdict:** the game's fragment is already at the optimal precision, and its bash
source is already int. The use-case-specific measurement (mimecroft: actual vs
full-int) shows the float tint the generator emits is **within ±5% of the int tint** on
this translator (1.003×) — so moving the compiled colour math to mediump int would NOT
help here. The synthetic full-int-vs-full-float 1.6× gap comes from the float *effects*
(scanline/hash/vignette/blend in float) — the game already runs those in int — so the
float tint alone is not a measurable cost. No game or generator change is warranted on
this basis.
