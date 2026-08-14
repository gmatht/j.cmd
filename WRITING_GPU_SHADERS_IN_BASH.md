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
