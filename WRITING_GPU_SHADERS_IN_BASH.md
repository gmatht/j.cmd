# Writing GPU Shaders in Bash

The sh→GLSL backend compiles a bash program into a **GLSL ES 1.00
(WebGL 1) shader** — both stages. You write a *pure-computation* bash
program — integer arithmetic over the stage's input bridges, `echo`/
`printf`/`putb` (fragment) or the `vp_*`/`vc_*`/`vu_*` output vars
(vertex) — and the backend emits real GLSL.

Pipeline (all in-process in the browser):

```
bash source ──debashl──▶ A1 shIR ──A2──▶ GLSL ES 1.00 shader
```

Driven by the `otranspilerl_glsl` / `otranspilerl_glslv` entries / the
`sh2glsl` / `sh2glsl --vertex` shell commands, or the otranspiler
GUI's `glsl` / `glslv` targets (sh sources; non-sh sources reach the
same backend through A1 render). The reference shaders are
`www/examples/mimecroft-frag.sh` (fragment, 68 lines) and
`www/examples/mimecroft-vertex.sh` (vertex, ~50 lines) — both compile
with 0 unsupported constructs and are what MIMEcroft actually runs.

**The rule of thumb:** if your bash needs a *process*, a *file*, or an
external binary, it cannot run on a GPU. Everything that maps to pure
integer computation — assignment, `$(( ))`, `echo`/`printf`, `putb`,
`if`/`while`/`for`/`case`, user functions, arrays, the
`echo "scale=K; …" | bc` float captures — becomes real GLSL.
Everything else renders as a `/* TODO(unsupported) */` marker and the
shader still compiles (that construct just does nothing).

---

## 1. The output model

A fragment shader has no terminal. The program's output is a byte
buffer, and the fragment colour is those bytes:

- `putb N` — write one byte (0–255) into the output buffer. In the
  render-fragment mode (the flavour the browser uses) the first four
  bytes **are** the pixel colour:
  `gl_FragColor = vec4(out_buf[0], out_buf[1], out_buf[2], out_buf[3]) / 255`.
- `echo` / `print` — words separated by single spaces, terminated by a
  newline, appended to the same byte stream (`putStr`/`putCh`).
- `printf 'fmt' args…` — literal formats with `%s`, `%d`, `%i`, `%%`
  and the `\n` `\t` `\r` `\\` escapes.

**Keep the output small.** The byte buffer is capped at **OUT_CAP =
4096** bytes. The string scratch region (runtime concatenation and
number-to-string) is also **4096** bytes.

## 2. Input bridges (render-fragment mode)

The shader is a *fragment* shader: it runs once per pixel. The backend
seeds these int globals at the top of `main()` when the program reads
them:

| variable | source |
|---|---|
| `frag_x`, `frag_y` | `int(gl_FragCoord.xy)` — the pixel position |
| `vcolor_r/g/b` | `int(vColor.rgb * 255.0)` — the vertex shader's varying colour |
| `uv_x`, `uv_y` | the texel index from the `vUv` varying (texture size 16) |
| `tex_r/g/b` | the sampled texel colour (0–255) |
| `damage`, `cr_r/g/b/a` | the crack-overlay texture (MIMEcroft's damaged blocks) |

There is **no `argv`**: `$1`, `$2`, … read at top level are empty (the
GPU has no command line). Inside a user function, positionals map to
the `g_pa[]` parameter array instead.

## 2b. Input bridges and outputs (render-VERTEX mode, `sh2glsl --vertex`)

The backend also emits a **vertex shader** (`vert_out` — the
`otranspilerl_glslv` entry / the `sh2glsl --vertex` command / the
GUI's `glslv` target). A vertex program has no bytes and no fragment
colour: it reads the attribute/uniform bridges and sets output vars
that the backend turns into `gl_Position` and the varyings.

| variable | source |
|---|---|
| `ap_x/y/z` | `int(aPosition.xyz * 1000.0)` — the cube corners (±500) |
| `ash_r/g/b` | `int(aShade.rgb * 1000.0)` — face brightness (450–1000) |
| `auv_u/v` | `int(aUv.xy * 1000.0)` — texture coordinates (0–1000) |
| `ucp_x/y/z` | `int(uCamPos.xyz * 1000.0)` — the camera (world units) |
| `ucy_m` | `int(uCamYaw * 1000.0)` — the yaw in milli-degrees (0–360000) |
| `ucs` | `int(uCamShift * 1000.0)` — the strafe screen-shift (milli-NDC) |
| `uop_x/y/z` | `int(uObjPos.xyz * 1000.0)` — the object centre (world) |
| `usc_x/y/z` | `int(uScale.xyz * 1000.0)` — the object scale (1 → 1000) |
| `ublk_r/g/b` | `int(uBlockColor.rgb * 1000.0)` — the block colour (0–1000) |
| `uov` | `int(uOverlay * 1000.0)` — 0/1000: the flat HUD-overlay path |

Outputs (all forced-declared; the backend emits the final lines):

| variable | becomes |
|---|---|
| `vp_x/y/z/w` | `gl_Position` (floats — set them via the bc captures) |
| `vc_r/g/b/a` | `vColor` (ints, ×1000 — `vec4(float(vc)/1000, …)`) |
| `vu_u/v` | `vUv` (ints, ×1000) |

Vertex programs use the **float bc captures** for the transform math:
`wx=$(echo "scale=4; $ap_x * $usc_x / 1000000.0 + $uop_x / 1000.0" | bc)`
etc. The float grammar covers `+ - * / % ^`, parens and the bc trig
`c(…)` / `s(…)` → GLSL `cos`/`sin` (the camera rotation). Two rules:

- **every capture needs a decimal-point literal** (`0.9`, `64.0`,
  `+ 0.0`) — the float-path gate; and
- **float vars chain**: a later capture reads an earlier float var
  directly (`g_rad` stays `float`, never a `float(int())` round-trip),
  and `vp_x=$wx` is a direct float copy.

`precision highp float/int` is always emitted for a vertex (ES 1.00
requires highp in vertex shaders — the mediump gate is fragment-only).
See `www/examples/mimecroft-vertex.sh` for the full worked example
(object→world, camera-relative delta, yaw rotation, the fake
perspective).

## 3. What works (the supported subset)

**Statements**

- Assignment: `x=5`, `x=$((...))`, and the compound forms `+=`, `-=`,
  `*=`, `/=`, `%=` (numeric variables; on a plain string var, bash's
  `+=` is a string append and stays a TODO).
- `if … then … elif … else … fi`, `while`, `do … while`, `for`
  (both `for i in …` and the C-style `for ((…))`), `case … esac`,
  `break`, `continue`.
- `local` declarations inside functions.
- `echo` / `print` / `printf` / `putb`.
- User functions — but see §4: they are **void** and **non-recursive**.

**Expressions (integer)**

- `$(( ))` arithmetic: `+ - * / %`, comparisons `== != < <= > >=`,
  logical `&& || !`, ternary `?:`, unary `- + ! ~`, exponent `**`
  (emitted as `ipow`).
- Integer literals, variable reads, array reads `arr[i]`, subscripts.
- `v=$(echo "scale=K; expr" | bc)` — the one pipeline that is
  supported: the `bc` capture becomes a GLSL **float** (or a dynamic
  integer form — `sqrt($x)` lowers to an integer `isqrt`, and
  var-operand scale-0 integer arithmetic works). This is how you get
  non-integer math.

**Types**

- Integers are the native type.
- Strings exist only as an immutable table: `ivec2 (offset, len)` into
  a `const int s_tab[]` of ASCII codes. Literal strings and
  `$var` interpolation work; runtime concatenation / number-to-string
  materialize into the 4096-byte `s_scratch` region.

## 4. What does NOT work (renders as `/* TODO(unsupported) */`)

These compile — the construct becomes a no-op marker — but the output
will be missing whatever they were supposed to do. A correct shader has
`// TODO(unsupported): 0 construct(s)` in its footer.

**Never supported (fundamentally unrepresentable on a GPU):**

- **External commands and processes**: `ls`, `grep`, `sed`, `date`,
  `cat`… anything that spawns or needs a binary.
- **Files**: redirections (`> file`, `2>&1`), `WriteFile`, heredocs.
- **Pipelines** (other than the `echo … | bc` capture above) and
  **subshells** `( )`.
- **Background** `&` jobs.

**Language constructs that are TODOs:**

- `exit N` (a bare `exit 0` is fine; `exit N` emits `discard;`).
- Top-level `return`, `goto`/`label`, `die`, `warn`, `try`, `require`.
- `exec` of a non-literal command name, and any command the backend
  doesn't know (the footer tells you exactly which: `exec ls`,
  `call foo`, …).
- `printf` with a non-literal format string.
- `putb` with no argument / more than one argument.
- `setVar` with a non-literal variable name; whole-array writes;
  `arr+=(…)` append (still compiles, marked TODO).
- Command substitution that isn't the `bc` form.

## 5. "You're on a GPU now" — the data model limits

- **Integers are 32-bit.** Bash arithmetic is i64-wrapping; GLSL ES
  `int` is i32. Literals outside i32 range render as
  `/* TODO(i64→i32 wrap: N) */ 0`. Keep numbers in i32 or accept the
  wrap.
- **No floats** except through the `bc` capture path.
- **No recursion.** GLSL forbids recursive calls; a recursive bash
  function will not render (the backend emits it as a call to itself,
  which fails to compile).
- **Functions are `void`.** Shell exit statuses are dropped; a function
  communicates through its output bytes and globals, not a return value.
  `return expr` is only legal as a bare `return;` inside a function.
- **Fixed caps** (the backend's compile-time limits, emitted as GLSL
  constants / array sizes): OUT_CAP 4096 (output bytes) ·
  SCRATCH_CAP 4096 (string materialization) · PARAM_CAP 64
  (function args, `g_pa[64]`) · ARR_CAP 1024 (array stores) ·
  FIT_CAP 1024 (for-iteration elements).
- **ES 1.00 specifics:** no `out` variables, no dynamic indexing into
  the output buffer — `putb` writes to a compile-time-constant index
  (`out_buf[N]`), so a runtime byte cursor (like the ES 3.00 flavor's
  `putCh`) is not available. Array syntax is the ES 1.00 form.

## 6. Checklist before you ship a shader

1. **Only** `echo`/`print`/`printf`/`putb` for output (fragment), and
   keep it under ~4 KB; a VERTEX program outputs through the
   `vp_*`/`vc_*`/`vu_*` vars instead — no `putb` there.
2. Read inputs only through the bridges (`frag_x`, `frag_y`,
   `vcolor_*`, `uv_*`, `tex_*`, `damage`, `cr_*` — or the vertex
   `ap_*`/`ash_*`/`auv_*`/`ucp_*`/`ucy_m`/`ucs`/`uop_*`/`usc_*`/
   `ublk_*`/`uov` set).
3. All integer arithmetic in `$(( ))` with i32-range values; use the
   `echo "scale=K; …" | bc` capture for anything fractional (with a
   decimal-point literal in every capture — the float-path gate).
4. No external commands, no files, no pipes (except the bc form), no
   subshells, no background jobs.
5. Functions: void, non-recursive, args by position (`$1` → `g_pa[]`).
6. Verify: run `sh2glsl your-shader.sh` (or `sh2glsl --vertex` for a
   vertex program, or the GUI's `glsl`/`glslv` target) and confirm the
   footer says `// TODO(unsupported): 0 construct(s)`. Any nonzero
   count names the constructs that silently did nothing.

## 6b. Automatic capability detection — `sh2glsl --check`

Checking the footer by hand is the manual workflow; the detector makes
it automatic and closes the three gaps where the footer **lies** (a
clean `0 construct(s)` footer on a shader that still fails to compile
or renders nothing):

```
$ sh2glsl --check your-shader.sh
sh2glsl --check /examples/your-shader.sh
fragment CAPABLE
vertex   NOT CAPABLE — byte output (echo/print/printf/putb) is not
         representable in a vertex shader — out_buf/out_len are
         fragment-only and undeclared here; output through vp_*/vc_*/vu_* instead
```

The report (`src/shglsl-capable.js`, the `glslCapable(src)` library
entry, or the `sh2.*glslCapable` namespace call) is:

```json
{
  "recursion": [],
  "fragment": { "capable": true, "total": 0, "unsupported": [], "warnings": [] },
  "vertex":   { "capable": false, "total": 0, "unsupported": [],
                 "warnings": ["byte output …"] }
}
```

- **`capable`** — the program compiles to a *working* shader for that
  stage: clean footer (0 unsupported) **and** no recursion **and** no
  stage-contract violation.
- **`unsupported`** — the `what`/`count` breakdown parsed from the
  rendered markers (`exec ls`, `pipeline`, `subshell`, `background`,
  `printf non-literal format`, `call split`, `arith parse`, …).
- **`warnings`** — compiles but renders nothing: a fragment program
  that only sets `vp_*`/`vc_*`/`vu_*` (no `gl_Position` in a fragment),
  a vertex program with no `vp_*`/`vc_*`/`vu_*` output, or no output
  at all.
- **`recursion`** — the cycle members (`["f","f"]` for a self-call,
  `["a","b","a"]` for mutual recursion). GLSL forbids recursion in
  every stage, but the backend emits a self-call with a clean footer —
  the detector walks the A1 shIR call graph to catch it.

The three footer blind spots, all caught by `--check`:

1. **Recursion** — the backend emits `g_f();` inside `void g_f()` with
   `0 construct(s)`; the shader then fails to compile. The detector
   finds the cycle in the shIR.
2. **Byte output in a vertex program** — `echo`/`print`/`printf`/
   `putb` lower to `putStr`/`putCh`/`out_buf`, which are fragment-only
   (`out_buf`/`out_len` are never declared in a vertex shader — the
   generated shader is broken with a clean footer).
3. **No output at all** — a fragment program that only sets `vp_*`
   (or a vertex program that only echoes) compiles but renders
   nothing; reported as a warning.

`sh2glsl --check` runs the same raw `otranspilerl_glsl`/`_glslv`
renders `sh2glsl` uses (the marker format and footer are the stable
contract), so the verdict is exactly what the compiler would produce —
no separate analysis pass to drift.

## 6c. The automatic pipeline — `sh2glsl --auto` (eval-fallback)

The endgame: replace the explicit `sh2glsl` step with a **plain eval**
— the runtime runs the bash as a normal shell program, and the
pipeline (`src/shglsl-auto.js`, the `glslAuto(src)` library entry, or
`sh2.*glslAuto`) automatically decides whether to transparently
offload it to the GPU. Four questions, four signals:

```
$ sh2glsl --auto your-shader.sh
sh2glsl --auto /examples/your-shader.sh
  static · shader: fragment · worth offloading
  fragment: capable · vertex: not capable · readsFrag: true · readsVert: false · loops: 0 · ops: 76
```

| question | signal |
|---|---|
| **(a) pre-compile & reuse** | the bash→GLSL translation is a pure function of the source text — `getShaderTranslation(src)` caches both stages by source string, so any re-eval reuses the compiled shaders. `static` additionally reports the program is self-contained (no `eval`/`source`/`.` — it is not a code generator whose real program only exists at runtime). |
| **(b) is it a shader** | the `glslCapable` verdict: compiles to a WORKING shader in ≥1 stage (clean footer, no recursion, no stage-contract violation). |
| **(c) what sort** | the output model decides the stage: byte output (`putb`/`echo`/`printf`) is fragment-only, `vp_*`/`vc_*`/`vu_*` writes are vertex-only — so a program is exactly one of `fragment` \| `vertex` \| `null` (a program that does both is broken in both stages; no output is not a shader). |
| **(d) worth it** | the GPU path has fixed overhead (compile, upload, render, readback), so it only pays when the work is **invocation-parameterized** — the program reads the stage's input bridges (the backend's use-gated declarations in the raw renders are the ground truth) — **and** the invocation count is large enough (pixels ≥ 4096 for a fragment, vertices ≥ 256 for a vertex). |

`x=3` fails all four: no output (not a shader), no bridge reads (the
GPU would compute the same result N times redundantly — the single
CPU eval always wins), trivial work. `putb $((frag_x % 256))` passes:
static, fragment, reads `frag_x` → per-pixel gradient → worth it.

The runtime decision is `shouldOffload(src)` → `offload` = static ∧
shader ∧ worth. When true, render the cached translation on the GPU;
otherwise eval the bash normally — the shader pipeline becomes
invisible.

## 6d. The factor.sh case study — how to run the benchmark

`www/examples/factor.sh` (bash trial division) and its C twin
`www/examples/c/factor.c` are the worked example of a partial lift:
the whole program is NOT a shader (argv, `exit`, regex `!`, array
append, `[ ]` tests — `sh2glsl --check` names them), but the
trial-division core IS liftable once the parallel dimension is
exposed (batch: one pixel per number; sieve: one pixel per divisor
candidate). `__factor-bench.mjs` measures the node-faithful half of
the decision:

```
node __factor-bench.mjs          # full table (min of 5 runs per number)
node __factor-bench.mjs --quick  # one run per number (CI)
```

It builds the C twin (`cc www/examples/c/factor.c -o /tmp/factor-c -O2`),
then reports:

1. **CPU fallback** — bash vs C wall time per number (360, 999983,
   2³¹−1, 999999937, 2³², 1000000007). On the measured box: C is
   **~114× faster** than bash on the same algorithm (267× for 2³¹−1:
   438 ms vs 1.6 ms).
2. **GPU-path fixed overhead** — the cold bash→GLSL compile (~29 ms,
   the same wasm the browser runs) and the cached re-eval
   (~0.003 ms — the (a) reuse win).
3. **Lift-pattern verdicts** — the batch and sieve shaders must be
   detected as shaders, worth it, with 0 unsupported (the gate fails
   loudly otherwise).
4. **Crossover** — the batch size where the GPU path (compile +
   render) beats the bash loop. With bash at ~165 ms/number and the
   GPU path fixed at ~30 ms, the GPU wins at **batch size 1** — a
   single large factorization pays for the whole pipeline.

The render half (per-pixel ALU, draw + readback) is browser-side —
measure it with `www/glsl-int-vs-float-bench.html` on a real GPU;
headless-gl on node is SwiftShader software rendering and would
mislead.

## 6e. The fuzzy-search case study — the chunk-and-reduce transform

`__fuzzy-bench.mjs` + `www/fuzzy-bench.html` + `src/fuzzygpu.js` are the
worked example of a **data-load transform**: a per-offset fuzzy
matcher (`score[x] = Σ|needle[i] − haystack[i+x]|`) whose GPU shape is
one pixel per offset — the whole needle loop runs in the fragment. The
load problem is that a pixel's result must round-trip through the RGBA
byte buffer, and the needle must fit the backend's inline-array cap:

| limit | value | what breaks above it |
|---|---|---|
| inline array (ARR_CAP) | 1024 elements | the needle (or haystack) can't embed — the backend stores past the declared `[1024]` (OOB, UB) |
| accumulator int | mediump ±2¹⁵ = 32767 (ES 1.00 minimum; highp needs `OES_fragment_precision_high`) | the per-pixel score wraps |
| RGBA pack | 0 … 2³¹−1 (4 exact byte writes + the A≥128 sentinel) | the score can't be represented |

**The transform (the pattern you proposed — break the needle into
chunks, reduce on the CPU):** `src/fuzzygpu.js` computes the chunk
size from the representability bounds, not a constant:

```
CHUNK_SIZE = floor(INT_MAX / MAXDIFF)      # INT_MAX = mediump int ±2¹⁵ (default)
                                           # MAXDIFF = max |a−b| over the data (digits → 9)
           = min(that, ARR_CAP)            # a chunk must still inline
```

Then it emits one shader source per chunk — the chunk inline + the
FULL haystack inline, the loop `score += |needle[i] − haystack[chunk_start + i + x]|`
(global index — every chunk needs the whole haystack) — ending in a
single `putb $((score))`, which the **pack transform**
(`packFragmentResultToRGBA` in `shglsl-opt.js`) widens into the four
exact little-endian byte writes + the A≥128 sentinel. The CPU reads
every pass's RGBA row, sums the partials per offset in JS numbers
(exact to 2⁵³), and takes the argmin. The per-pass guarantee:

```
partial_c[x] ≤ CHUNK_SIZE·MAXDIFF ≤ INT_MAX      # accumulator can't wrap
partial_c[x] ≤ 2³¹−1                              # RGBA pack can't overflow
```

headroom at mediump: 2³¹−1/32767 ≈ 65,535× — and a future 1M-digit
chunk (9·10⁶ ≪ 2³¹−1) still packs, so the transform is scale-agnostic:
chunking is about *representability*, the array cap just sets the
largest chunk that can inline today.

`__fuzzy-bench.mjs` verifies the node-faithful half and the emitted
code (exit ≠ 0 on any regression):

1. **chunk-size derivation** — digits: floor(32767/9) = 3640 → capped
to 1024; a 0..255 domain: 128; a 0..999 domain: 32; highp digits:
238,609,294. Same formula, different data.
2. **correctness gate** — the chunked reduce (multi-chunk: 3, 3 and
   15 chunks) equals the exact CPU reference and the C twin, offset by
   offset; the generic-domain case too.
3. **pack-text verification** — the *emitted* `out_buf[i]` byte
   formulas are parsed out of the transformed GLSL and evaluated for
   sample scores; they must decode exactly to the score's bytes
   (the transform's output, not a reimplementation, is what's checked).
4. **the pipeline price** — one cold bash→GLSL compile per chunk
   (~15-45 ms/chunk here; the cached re-eval is ~0.001 ms). Chunking is
   exact and overflow-proof, but it pays a compile per chunk — the
   compile-once template + data-in-texture variant is the remaining
   price reduction at scale (the texture-window transport in §6f
   already removes the *array* limit).

`www/fuzzy-bench.html` runs the same generator in the browser: single-
pass vs chunked, per-pass draw+readback, the CPU reduce, and three
PASS checks — the chunked argmin equals the single-pass argmin, every
offset equals, and 0 sentinels. (The same shader equality is runnable
on node with headless-gl — SwiftShader, so timing misleads, but the
shader correctness is real.)

## 6f. The texture-window transport — haystack past the array cap

The chunk-and-reduce transform (§6e) still needs the haystack inline
(ARR_CAP 1024) — every needle chunk scores against the FULL haystack, so
the haystack is the binding cap. The texture-window transport removes it:
the haystack becomes an uploaded W×H RGBA texture (digit in the R byte),
and the shader reads it through the `tex_*` bridge at a program-set
`tex_idx`. The needle loop sets `tex_idx = chunk_start + i + x` before
reading `tex_r`:

```
while [ $i -lt $chunk_len ]; do
    tex_idx=$(( chunk_start + i + x ))
    diff=$(( needle[i] - tex_r ))
    ...
done
```

**The gap this fills:** the backend emits a texture sample ONLY for a
top-level `tex_*` read (`vec4 _tex = texture2D(uTex, fract(vUv));`), and
even then the uv is the interpolated varying, not a program value. A
tex read INSIDE a loop emits NO sample at all — `g_tex_r` is declared
and never assigned (silently uninitialized). `liftTextureWindowSample`
(`shglsl-opt.js`) rewrites every tex USE into a per-use sample at the
index:

```glsl
g_diff = ((g_needle[g_i]) - int(texture2D(uTex,
    vec2((float((g_tex_idx - (4096 * (g_tex_idx / 4096)))) + 0.5) / 4096.0,
         (float((g_tex_idx / 4096)) + 0.5) / 2.0)).r * 255.0));   // W×H layout
```

The 2D layout (row = idx/W, col = idx − W·(idx/W) — exact int div, no `%`)
means a 4096×N texture holds ~16384·N haystack digits. The pass also
strips the hoisted `fract(vUv)` sample and promotes the fragment to
`precision highp float;` — mandatory for wide textures: the texel-centre
uv `(idx+0.5)/W` and the `digit/255 × 255` decode both need > mediump
mantissa (at fp16 the coordinate quantises past ~2K texels and the
round-trip can truncate a digit). Note the ES 1.00 caveat: highp float in
a fragment needs `OES_fragment_precision_high` on mobile — the harness is
a desktop-compute experiment, so that's accepted and reported on failure.

**What it unlocks (measured):** haystack lengths far past ARR_CAP on the
real shaders — hl = 5000 (4096×2) and hl = 12000 (4096×3), single- and
multi-chunk, all reduce EXACTLY to the CPU reference (0 sentinels) on
headless-gl (`gl-tex-gate.mjs`, the same shaders the browser runs). The
bench §4 also checks the emitted uv arithmetic by extracting the
col/row expressions from the transformed text and evaluating them
(col=idx%4096, row=idx/4096 over sample indices), the fail-safe refusal
on a foreign index variable, and the no-GPU semantics at hl » ARR_CAP.

**The offset axis tiles** (`tileOffsetUniform`, §6f continuation): the
canvas is one pixel per offset, capped at MAX_TEXTURE_SIZE (~16384).
Past that the offset axis splits into tiles and the SAME compiled
shader runs every tile — the pass injects `uniform int uTileStart;` and
rewrites the frag_x bridge to `g_x = (g_frag_x + uTileStart)`, so the
data varies per tile at bind time, not compile time. Measured: hl =
24000 (23501 offsets → 3 tiles at 8192 px, texture 4096×6) reduces
exactly to the CPU reference on headless-gl.

## 6g. The compile-once template — the needle moves into uCrack

The remaining cost above is now removed. `fuzzyTemplateShader`
(`src/fuzzygpu.js`) is a **data-independent source** — no needle digits
at all — and the needle reads from the SECOND sampler, uCrack, via the
`cr_*` bridge (which has the SAME loop-read-no-sample gap as `tex_*`,
filled by the same `liftTextureWindowSample` pass, now extended to both
samplers with separate index vars `tex_idx` / `crack_idx`):

```
while [ $i -lt $needle_len ]; do
    tex_idx=$(( chunk_start + i + x ))   # haystack window (uTex)
    crack_idx=$(( chunk_start + i ))     # needle window (uCrack)
    diff=$(( cr_r - tex_r ))
    ...
done
```

`needleLengthUniform` then turns the two baked per-chunk constants into
uniforms, so ONE compiled shader runs every chunk of any needle:

```
g_needle_len  = 0;   →   g_needle_len  = uNeedleLen;
g_chunk_start = 0;   →   g_chunk_start = uNeedleStart;
```

**The loop-bound decision (made explicit):** the needle loop bound is a
DYNAMIC UNIFORM (`while (g_i < uNeedleLen)`), chosen over fixed-geometry
+ padding. Verified working on SwiftShader and ANGLE (the gate renders
it at nl=2000 » ARR_CAP and hl=24000 tiled, exact). The ES 1.00
tradeoff: the strictest early mobile drivers require statically
computable loop counts — the fixed-geometry + validity-mask padding
variant (full-C loop, the needle texture's G channel masks padding) is
the documented fallback for those. `precision highp float` is required
(the same wide-texture + /255-decode argument as §6f).

**Measured (`__fuzzy-bench.mjs` §5):** template = **1 compile** (~4 ms)
vs the chunked path's m compiles (~15 ms each) for the same
nl=2000/C=700 — and the needle is a texture window, so nl=1M is still
**ONE compile** (~4 ms) vs 977 chunked compiles (~15 s): the per-chunk
compile cost is GONE. The gate (`gl-tex-gate.mjs` section B) verifies
the real shaders on headless-gl at nl=2000 (needle » ARR_CAP),
multi-chunk, and tiled hl=24000 — all reduce EXACTLY to the CPU
reference, 0 sentinels, compiles=1. The browser harness gains a
template/chunked selector; the overflow-free bound is unchanged (per
partial ≤ INT_MAX; chunking exists only for that bound, and the uniform
window makes the chunk count FREE).
---

See `www/examples/mimecroft-frag.sh` (CRT scanlines, per-pixel
corruption hashing, vignette, textured blocks with a crack overlay)
and `www/examples/mimecroft-vertex.sh` (object→world, the yaw rotation
via bc trig, the fake perspective, the strafe shift, the overlay path)
for shaders that do all of this and compile clean. The backend lives in
`sh2perl/src/glsl_backend.rs`; the browser entries are
`otranspilerl_glsl` (fragment) and `otranspilerl_glslv` (vertex) in
`otranspilerl/src/wasi.rs` — the `sh2glsl` / `sh2glsl --vertex` shell
commands in the browser and the Node CLI.
