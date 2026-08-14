#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# texture-jpeg.sh — a tiny photo — sky gradient, sun, green hills, and the 8×8 DCT grid JPEG is famous for
#
#   bash texture-jpeg.sh > jpeg.ppm      # PPM P6, 16×16 (default)
#   bash texture-jpeg.sh --preview           # truecolor ANSI preview
#   bash texture-jpeg.sh --png               # jpeg-<seed>.png (needs convert)
#   TEX_SIZE=32 TEX_SEED=7 bash texture-jpeg.sh > jpeg32.ppm
#
# Self-contained (no sourcing): the shared core from texture-lib.sh is
# inlined below, so the script runs identically under host bash, the
# real-bash wasm, and jtsh's transpiled bash (a sourced lib runs in a
# separate runtime there, losing variables — inlining avoids that).
# texture-lib.sh stays the canonical reference; __texture-test.mjs
# fails the suite if these drift.
# ─────────────────────────────────────────────────────────────────────

NAME="jpeg"
PREVIEW=0
DO_PNG=0
if [ "$1" = "--preview" ]; then PREVIEW=1; fi
if [ "$2" = "--preview" ]; then PREVIEW=1; fi
if [ "$3" = "--preview" ]; then PREVIEW=1; fi
if [ "$1" = "--png" ]; then DO_PNG=1; fi
if [ "$2" = "--png" ]; then DO_PNG=1; fi
if [ "$3" = "--png" ]; then DO_PNG=1; fi
DO_TSV=0
if [ "$1" = "--tsv" ]; then DO_TSV=1; fi
if [ "$2" = "--tsv" ]; then DO_TSV=1; fi
if [ "$3" = "--tsv" ]; then DO_TSV=1; fi

# settings args: `--tsv --size 32 --seed 7` — the game's pre-game menu
# passes the resolution/seed; they become TEX_SIZE/TEX_SEED for the
# inlined config below (env still wins: it is read first)
if [ "$2" = "--size" ]; then TEX_SIZE=$3; fi
if [ "$4" = "--size" ]; then TEX_SIZE=$5; fi
if [ "$2" = "--seed" ]; then TEX_SEED=$3; fi
if [ "$4" = "--seed" ]; then TEX_SEED=$5; fi

# ─── shared core (inlined from texture-lib.sh) ──────
#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# texture-lib.sh — shared core for the pseudorandom texture
# generators (texture-wood.sh / texture-grass.sh / texture-stone.sh).
#
# Everything here is pure integer arithmetic: no floats, no `$RANDOM`,
# no `local`, no C-style for loops, no `$(( ... ))` inlined inside test
# brackets — the same language discipline as examples/mimecroft.sh, so
# the whole generation core also transpiles through bash2js
# (src/bash2js.js) for the in-browser sh2runtime. The only host-side
# bits are the `printf` I/O calls in emit()/finish().
#
# Noise model (all tileable):
#   • Park–Miller LCG (`rand`) for the structural randomness — knot
#     positions, blade columns, crack segments
#   • value noise (`vnoise2`) whose lattice points are hashed with
#     wrap-around on both axes, so the textures tile seamlessly;
#     the noise never consumes the LCG stream
#
# Output: PPM P6 on stdout (pipe into ImageMagick to convert), or
# `--preview` for a truecolor ANSI block preview in the terminal.
# `--png` writes <name>-<seed>.png via ImageMagick when available.
#
# Configuration: TEX_SIZE (pixels, default 16, rounded down to a
# multiple of 8) and TEX_SEED (default 20240812).
# ─────────────────────────────────────────────────────────────────────

# ─── configuration ──────────────────────────────────────────────────
# luminance ramp for the preview glyphs (dark→light)
SHADE=" .:-=+*#%@"
# NOTE: read the env FIRST — a plain `TEX_SIZE=16` assignment would
# clobber any value exported by the caller.
SIZE=16
if [ "$TEX_SIZE" != "" ]; then SIZE=$TEX_SIZE; fi
if [ "$SIZE" -lt 1 ]; then SIZE=1; fi
m4=$(( SIZE % 4 ))
if [ "$m4" -ne 0 ] && [ "$SIZE" -gt 4 ]; then SIZE=$(( (SIZE / 4) * 4 )); fi
# MIME name textures: always at least 64×64 — the type name is drawn
# at a glyph scale that fills the width (2-4px strokes instead of 1px),
# so it stays readable on the 0.7-unit mime cubes
if [ "$SIZE" -lt 64 ]; then SIZE=64; fi
LAST=$(( SIZE - 1 ))

if [ "$TEX_SEED" = "" ]; then TEX_SEED=20240812; fi
if [ "$SEED" != "" ]; then TEX_SEED=$SEED; fi
seed=$TEX_SEED
noise_seed=$TEX_SEED

# value-noise lattice geometry, derived from SIZE so the textures
# scale up without changing their character
LOW_CELL=$(( SIZE / 4 ))
if [ "$LOW_CELL" -lt 1 ]; then LOW_CELL=1; fi
HIGH_CELL=$(( SIZE / 8 ))
if [ "$HIGH_CELL" -lt 1 ]; then HIGH_CELL=1; fi
LOW_WRAP=4
HIGH_WRAP=8

# ─── loop-var bridge ────────────────────────────────────────────────
# the A1 transpiler types purely-local while-loop induction counters
# (x/y) as int64, which then leaks BigInt into the mixed per-pixel
# arithmetic (`dx * C1DY - dy * C1DX`) as a hard TypeError in the
# browser. A global reference inside a function body (even uncalled)
# unifies the counters back into the plain-number domain. No-op here.
tex_loop_bridge() { y=$(( y + 0 )); x=$(( x + 0 )); }

# ─── pseudorandom core ──────────────────────────────────────────────
# probe printf -v support (host bash and the real-bash wasm have it;
# the transpiled sh2 printf and external printfs don't). Without this,
# the PPM byte path calls printf once per channel (768 times) and the
# shell floods the terminal with "-v"/excess-arg noise. When -v is
# missing, fall back to the ANSI preview (unless --tsv, which is plain
# text and works everywhere). The probe sets probe_ok in THIS shell —
# no command substitution (subshells lose the var) and no 2>&1 (the
# transpiled redirect layer mangles it into a file named "&1").
printf -v probe_ok 'x' 2>/dev/null > /dev/null
if [ "$probe_ok" != "x" ]; then
  if [ "$PREVIEW" -eq 0 ]; then
    if [ "$DO_TSV" -eq 0 ]; then
      PREVIEW=1
      echo "note: this shell's printf cannot emit PPM bytes (no -v) — showing the preview instead; use host bash for .ppm/.png, or --tsv for a text output"
    fi
  fi
fi
# ─── stats ───────────────────────────────────────────────────────────
# wall-clock profiling, µs resolution, works in EVERY shell:
#   • host bash / real-bash wasm → EPOCHREALTIME (builtin var, no
#     subshell — per-pixel ticks stay cheap)
#   • jtsh's transpiled shell → `date +%s%N` returns Date.now()*1e6
#     (fine for RELATIVE deltas)
# First tick() that succeeds flips STATS_OK on. Output: host/wasm →
# stderr (keeps PPM/TSV files clean); jtsh → stdout (its stderr
# redirect is lossy, and jtsh only ever runs the text preview/tsv).
STATS_OK=0
stat_setup=0
stat_loop=0
stat_emit=0
stat_finish=0
t_last=0

tick() {
  t_now=$EPOCHREALTIME
  if [ "$t_now" != "" ]; then
    # "SECONDS.MICROS" → integer microseconds
    t_now=${t_now%.*}${t_now#*.}
    STATS_OK=1
  else
    t_now=$(date +%s%N 2>/dev/null)
    if [ "$t_now" != "" ]; then
      t_now=$(( t_now / 1000 ))
      STATS_OK=1
    else
      t_now=0
    fi
  fi
}

# accumulate the µs since the last stat point into a named bucket
stat_span() {
  ss_name=$1
  tick
  if [ "$STATS_OK" -eq 1 ]; then
    ss_d=$(( t_now - t_last ))
    if [ "$ss_name" = "setup" ]; then stat_setup=$(( stat_setup + ss_d )); fi
    if [ "$ss_name" = "loop" ]; then stat_loop=$(( stat_loop + ss_d )); fi
    if [ "$ss_name" = "emit" ]; then stat_emit=$(( stat_emit + ss_d )); fi
    if [ "$ss_name" = "finish" ]; then stat_finish=$(( stat_finish + ss_d )); fi
    t_last=$t_now
  fi
}

# print "#stats: …" to stderr with ms + % of total
print_stats() {
  if [ "$STATS_OK" -eq 1 ]; then
    ps_total=$stat_total
    if [ "$ps_total" -lt 1 ]; then ps_total=1; fi
    ps_gen=$stat_loop
    fmt_us() {
      fu_v=$1
      fu_ms=$(( fu_v / 1000 ))
      fu_frac=$(( (fu_v % 1000) / 100 ))
      fv="${fu_ms}.${fu_frac}"
    }
    fmt_us $stat_setup
    ps_s=$fv
    fmt_us $ps_gen
    ps_g=$fv
    fmt_us $stat_emit
    ps_e=$fv
    fmt_us $stat_finish
    ps_f=$fv
    fmt_us $ps_total
    ps_t=$fv
    ps_sp=$(( stat_setup * 100 / ps_total ))
    ps_gp=$(( ps_gen * 100 / ps_total ))
    ps_ep=$(( stat_emit * 100 / ps_total ))
    ps_fp=$(( stat_finish * 100 / ps_total ))
    if [ "$probe_ok" = "x" ]; then
      echo "#stats: setup=${ps_s}ms(${ps_sp}%) gen=${ps_g}ms(${ps_gp}%) emit=${ps_e}ms(${ps_ep}%) finish=${ps_f}ms(${ps_fp}%) total=${ps_t}ms" >&2
    else
      echo "#stats: setup=${ps_s}ms(${ps_sp}%) gen=${ps_g}ms(${ps_gp}%) emit=${ps_e}ms(${ps_ep}%) finish=${ps_f}ms(${ps_fp}%) total=${ps_t}ms"
    fi
  else
    if [ "$probe_ok" = "x" ]; then
      echo "#stats: no clock found (need EPOCHREALTIME or date +%s%N)" >&2
    else
      echo "#stats: no clock found in this shell"
    fi
  fi
}

tick
t_last=$t_now
t0v=$t_now
# Park–Miller LCG; result rv ∈ [0, rn_m)
rand() {
  rn_m=$1
  seed=$(( (seed * 48271) % 2147483647 ))
  rv=$(( seed % rn_m ))
}

# lattice hash — deterministic per (x, y) with wrap-around on both
# axes so the value noise tiles seamlessly; result lhn ∈ [0, 255]
#
# Golden-ratio hash (Knuth) folded through an XOR-shift and an odd
# multiplier, with the seed XORed in last. The naive `(a*x + b*y + c)
# % 256` is linear mod 256 for ANY constants, so it makes ordered
# ramps instead of noise; this mixes the low coordinate bits upward
# via carries, which is what `% 256` of a linear sum cannot do.
lat_hash() {
  lh_x=$1
  lh_y=$2
  lh_wx=$3
  lh_wy=$4
  lh_x=$(( lh_x % lh_wx ))
  lh_y=$(( lh_y % lh_wy ))
  lhn_x=$(( lh_x * 64 + lh_y ))
  lhz=$(( (lhn_x * 2654435761) % 2147483647 ))
  lhz=$(( lhz ^ (lhz >> 13) ))
  lhz=$(( (lhz * 73454075) % 2147483647 ))
  lhz=$(( lhz ^ ((noise_seed * 1013) % 2147483647) ))
  lhn=$(( (lhz >> 16) % 256 ))
}

# smoothstep weight, t ∈ [0, 256] → swv ∈ [0, 256]
smooth_w() {
  sw_t=$1
  swv=$(( sw_t * sw_t * (768 - 2 * sw_t) / 65536 ))
}

# 2-D value noise with (possibly anisotropic) lattice cells; wraps on
# both axes → tileable. result vn_res ∈ [0, 255]
vnoise2() {
  vn_x=$1
  vn_y=$2
  vn_cx=$3
  vn_cy=$4
  vn_wx=$5
  vn_wy=$6
  vn_x0=$(( vn_x / vn_cx ))
  vn_y0=$(( vn_y / vn_cy ))
  vn_x1=$(( vn_x0 + 1 ))
  vn_y1=$(( vn_y0 + 1 ))
  vn_fx=$(( vn_x % vn_cx ))
  vn_fy=$(( vn_y % vn_cy ))
  lat_hash $vn_x0 $vn_y0 $vn_wx $vn_wy
  vn_n00=$lhn
  lat_hash $vn_x1 $vn_y0 $vn_wx $vn_wy
  vn_n10=$lhn
  lat_hash $vn_x0 $vn_y1 $vn_wx $vn_wy
  vn_n01=$lhn
  lat_hash $vn_x1 $vn_y1 $vn_wx $vn_wy
  vn_n11=$lhn
  vn_tx=$(( vn_fx * 256 / vn_cx ))
  vn_ty=$(( vn_fy * 256 / vn_cy ))
  smooth_w $vn_tx
  vn_sx=$swv
  smooth_w $vn_ty
  vn_sy=$swv
  vn_top=$(( vn_n00 + (vn_n10 - vn_n00) * vn_sx / 256 ))
  vn_bot=$(( vn_n01 + (vn_n11 - vn_n01) * vn_sx / 256 ))
  vn_res=$(( vn_top + (vn_bot - vn_top) * vn_sy / 256 ))
}

# clamp to [0, 255] → cv
clamp() {
  cl_v=$1
  if [ "$cl_v" -lt 0 ]; then cl_v=0; fi
  if [ "$cl_v" -gt 255 ]; then cl_v=255; fi
  cv=$cl_v
}

# ─── output ─────────────────────────────────────────────────────────
# out = binary pixel stream (one byte per channel as \ooo escapes —
# host bash only; the transpiled sh2 printf can't emit arbitrary
# bytes, so in jtsh use --preview); prev = ANSI truecolor blocks for
# --preview. Call emit() once per pixel with r/g/b set.
#
# The preview escapes use \x1b (not \033): bash's printf turns \x1b
# into ESC, and the bash2js transpiler renders \x1b as a JS hex
# escape (real ESC byte) — \033 is rejected by the transpiler
# (octal escapes are illegal in JS template literals).
out=""
prev=""
tsv=""
emit() {
  if [ "$PREVIEW" -eq 1 ]; then
    # 256-color cube (16 + 36r + 6g + b) — far more terminals render
    # 48;5;N than truecolor 48;2;R;G;B
    c256=$(( 16 + (r / 51) * 36 + (g / 51) * 6 + b / 51 ))
    # a luminance shade glyph too, so the texture stays visible even
    # in terminals that strip or ignore the SGR color codes
    lum=$(( (r * 3 + g * 6 + b) / 10 ))
    lvl=$(( lum * 9 / 255 ))
    ch=${SHADE:$lvl:1}
    prev="$prev\x1b[48;5;${c256}m$ch"
    # row end: x (the column) cycles 0..LAST within every row, so the
    # reset fires once per row; checking y (the row counter) would only
    # fire during the last row and smear the whole texture onto one line
    if [ "$x" -eq "$LAST" ]; then
      prev="$prev\x1b[0m\n"
    fi
  elif [ "$DO_TSV" -eq 1 ]; then
    # TSV: three tab-separated NUMBERS per pixel (R, G, B), rows end
    # with a trailing tab + newline. No commas: the transpiled shell's
    # ${var#*sep} prefix-strip is greedy, so only %%-based field reads
    # and char-strips are used by readers. The \t/\n stay literal here
    # (printf converts them in host bash; the transpiler makes them
    # real bytes in the JS string so echo works too).
    tsv="$tsv$r	$g	$b	"
    if [ "$x" -eq "$LAST" ]; then
      tsv="$tsv
"
    fi
  else
    printf -v oc '%03o' "$r"
    out="$out\\$oc"
    printf -v oc '%03o' "$g"
    out="$out\\$oc"
    printf -v oc '%03o' "$b"
    out="$out\\$oc"
  fi
}


# finish — PPM P6 on stdout, or PNG via ImageMagick when --png
finish() {
  stat_span "finish"
  tick
  stat_total=$(( t_now - t0v ))
  if [ "$PREVIEW" -eq 1 ]; then
    printf "%b" "$prev"
    print_stats
    return 0
  fi
  if [ "$DO_TSV" -eq 1 ]; then
    # header + all cells are TAB-separated (header ends with a trailing
    # tab before the newline, like every row): readers strip fields with
    # tab patterns only — the transpiled shell's SPACE patterns are
    # unreliable, tab patterns are not. The \t/\n stay literal here
    # (printf converts them in host bash; the transpiler makes them
    # real bytes in the JS string so echo works too).
    if [ "$probe_ok" = "x" ]; then
      printf "#texture	$NAME	${SIZE}x${SIZE}	seed	$TEX_SEED	
$tsv"
    else
      echo "#texture	$NAME	${SIZE}x${SIZE}	seed	$TEX_SEED	
$tsv"
    fi
    print_stats
    return 0
  fi
  if [ "$DO_PNG" -eq 1 ]; then
    if command -v convert > /dev/null 2>&1; then
      printf "P6\n$SIZE $SIZE\n255\n$out" | convert ppm:- "$NAME-$TEX_SEED.png"
      echo "wrote $NAME-$TEX_SEED.png (${SIZE}x${SIZE}, seed $TEX_SEED)" >&2
    else
      echo "ImageMagick 'convert' not found — writing PPM to stdout" >&2
      printf "P6\n$SIZE $SIZE\n255\n$out"
    fi
    print_stats
    return 0
  fi
  printf "P6\n$SIZE $SIZE\n255\n$out"
  print_stats
}
# ─── body ───────────────────────────────────────────
# ─── the mime type text: the prefix (small 2×3 font) + the type name
# (3×5 font). Small-font glyphs are 2-wide × 3-tall, 6-bit ints,
# row-major (bitpos = row*2 + col, bit0 = top-left).
spfx=(I M A G E /)
spfxn=6
bnm=(J P E G)
bnmlen=4
spgi=(0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0)
spgi[0]=38    # I
spgi[1]=46    # M
spgi[2]=59    # A
spgi[3]=62    # G
spgi[4]=63    # E
spgi[5]=26    # /
bngi=(0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0)
bngi[0]=31524    # J
bngi[1]=4843    # P
bngi[2]=29391    # E
bngi[3]=31695    # G
# the prefix line: the 2×3 font at 2× scale — a small tag above the name
tt_pgs=2
tt_pfy0=$(( SIZE / 5 ))
tt_psx=$(( ( SIZE - spfxn * 2 * tt_pgs ) / 2 ))
# the name line: the 3×5 font scaled so it spans ~90% of the width
tt_ngs=$(( ( SIZE * 9 / 10 ) / ( bnmlen * 4 ) ))
if [ "$tt_ngs" -lt 2 ]; then tt_ngs=2; fi
tt_nfy0=$(( SIZE / 2 ))
tt_nsx=$(( ( SIZE - bnmlen * 4 * tt_ngs ) / 2 ))
y=0
while [ "$y" -lt "$SIZE" ]; do
  x=0
  while [ "$x" -lt "$SIZE" ]; do
    # sky gradient: brighter toward the horizon
    r=$(( 80 + y * 6 ))
    g=$(( 130 + y * 4 ))
    b=$(( 200 + y * 2 ))
    # green hills below the horizon
    if [ "$y" -ge 9 ]; then
      r=$(( 40 + (y - 9) * 8 ))
      g=$(( 110 + (y - 9) * 7 ))
      b=$(( 35 + (y - 9) * 4 ))
    fi
    # the sun at (11,3)
    dxx=$(( x - 11 ))
    dyy=$(( y - 3 ))
    d2=$(( dxx * dxx + dyy * dyy ))
    if [ "$d2" -le 5 ]; then
      r=252
      g=240
      b=110
    fi
    # the JPEG 8×8 DCT grid: block seams ring slightly lighter, and
    # each block gets its own faint tone (the blockiness of lossy JPEG)
    bx=$(( x % 8 ))
    by=$(( y % 8 ))
    lat_hash $(( x / 8 )) $(( y / 8 )) 2 2
    if [ "$bx" -eq 0 ] || [ "$by" -eq 0 ]; then
      r=$(( r + 18 ))
      g=$(( g + 14 ))
      b=$(( b + 10 ))
    fi
    if [ "$(( lhn % 7 ))" -eq 0 ]; then
      r=$(( r + (lhn % 16) ))
    fi
    clamp $r
    r=$cv
    clamp $g
    g=$cv
    clamp $b
    b=$cv
    # text overlay — INLINE, no function calls: the game runs texture
    # scripts via the BARE `bash` builtin (the async bash→JS transpiler,
    # not /bin/bash), and an unawaited per-pixel function call piled up
    # promises until the process OOMed. Pure arithmetic + array reads.
    # The OWN pixel is checked FIRST (white), then the 8 neighbours for
    # the black outline — a glyph stroke must not outline itself.
    tt_px=$x
    tt_py=$y
    # the mime type text — the prefix (small 2×3 font) on y 0..3, the
    # name (3×5 font) on y 6..11 — both centered. INLINE, no function
    # calls (the game runs these via the bare `bash` transpiler;
    # unawaited per-pixel calls OOM it). Own pixel first (white), then
    # the 8-neighbour outline (black).
    tt_on=0
    if [ "$tt_py" -ge "$tt_pfy0" ] && [ "$tt_py" -lt $(( tt_pfy0 + 3 * tt_pgs )) ]; then
      tt_gr=$(( ( tt_py - tt_pfy0 ) / tt_pgs ))
      tt_x0=$tt_psx
      tt_x1=$(( tt_psx + spfxn * 2 * tt_pgs ))
      if [ "$tt_px" -ge "$tt_x0" ] && [ "$tt_px" -lt "$tt_x1" ]; then
        tt_gc=$(( ( tt_px - tt_x0 ) / ( 2 * tt_pgs ) ))
        tt_gcol=$(( ( tt_px - tt_x0 - tt_gc * 2 * tt_pgs ) / tt_pgs ))
        if [ "$tt_gcol" -lt 2 ]; then
          tt_gi=${spgi[$tt_gc]}
          tt_bitpos=$(( tt_gr * 2 + tt_gcol ))
          tt_bit=$(( ( tt_gi >> tt_bitpos ) & 1 ))
          if [ "$tt_bit" -eq 1 ]; then tt_on=1; fi
        fi
      fi
    fi
    if [ "$tt_on" -eq 0 ] && [ "$tt_py" -ge "$tt_nfy0" ] && [ "$tt_py" -lt $(( tt_nfy0 + 5 * tt_ngs )) ]; then
      tt_gr=$(( ( tt_py - tt_nfy0 ) / tt_ngs ))
      tt_x0=$tt_nsx
      tt_x1=$(( tt_nsx + bnmlen * 4 * tt_ngs ))
      if [ "$tt_px" -ge "$tt_x0" ] && [ "$tt_px" -lt "$tt_x1" ]; then
        tt_gc=$(( ( tt_px - tt_x0 ) / ( 4 * tt_ngs ) ))
        tt_gcol=$(( ( tt_px - tt_x0 - tt_gc * 4 * tt_ngs ) / tt_ngs ))
        if [ "$tt_gcol" -lt 3 ]; then
          tt_gi=${bngi[$tt_gc]}
          tt_bitpos=$(( tt_gr * 3 + tt_gcol ))
          tt_bit=$(( ( tt_gi >> tt_bitpos ) & 1 ))
          if [ "$tt_bit" -eq 1 ]; then tt_on=1; fi
        fi
      fi
    fi
    if [ "$tt_on" -eq 1 ]; then
      # 70% opaque text — blend the white glyph over the pixel's own
      # colour so the texture shows through
      r=$(( (250 * 70 + r * 30) / 100 ))
      g=$(( (250 * 70 + g * 30) / 100 ))
      b=$(( (250 * 70 + b * 30) / 100 ))
    else
      tt_done=0
      tt_cand=0
      while [ "$tt_cand" -lt 8 ] && [ "$tt_done" -eq 0 ]; do
        tt_offx=$(( tt_cand % 3 ))
        tt_offy=$(( tt_cand / 3 ))
        tt_px=$(( x + tt_offx - 1 ))
        tt_py=$(( y + tt_offy - 1 ))
        if [ "$tt_offx" -ne 1 ] || [ "$tt_offy" -ne 1 ]; then
          tt_on=0
          if [ "$tt_py" -ge "$tt_pfy0" ] && [ "$tt_py" -lt $(( tt_pfy0 + 3 * tt_pgs )) ]; then
            tt_gr=$(( ( tt_py - tt_pfy0 ) / tt_pgs ))
            tt_x0=$tt_psx
            tt_x1=$(( tt_psx + spfxn * 2 * tt_pgs ))
            if [ "$tt_px" -ge "$tt_x0" ] && [ "$tt_px" -lt "$tt_x1" ]; then
              tt_gc=$(( ( tt_px - tt_x0 ) / ( 2 * tt_pgs ) ))
              tt_gcol=$(( ( tt_px - tt_x0 - tt_gc * 2 * tt_pgs ) / tt_pgs ))
              if [ "$tt_gcol" -lt 2 ]; then
                tt_gi=${spgi[$tt_gc]}
                tt_bitpos=$(( tt_gr * 2 + tt_gcol ))
                tt_bit=$(( ( tt_gi >> tt_bitpos ) & 1 ))
                if [ "$tt_bit" -eq 1 ]; then tt_on=1; fi
              fi
            fi
          fi
          if [ "$tt_on" -eq 0 ] && [ "$tt_py" -ge "$tt_nfy0" ] && [ "$tt_py" -lt $(( tt_nfy0 + 5 * tt_ngs )) ]; then
            tt_gr=$(( ( tt_py - tt_nfy0 ) / tt_ngs ))
            tt_x0=$tt_nsx
            tt_x1=$(( tt_nsx + bnmlen * 4 * tt_ngs ))
            if [ "$tt_px" -ge "$tt_x0" ] && [ "$tt_px" -lt "$tt_x1" ]; then
              tt_gc=$(( ( tt_px - tt_x0 ) / ( 4 * tt_ngs ) ))
              tt_gcol=$(( ( tt_px - tt_x0 - tt_gc * 4 * tt_ngs ) / tt_ngs ))
              if [ "$tt_gcol" -lt 3 ]; then
                tt_gi=${bngi[$tt_gc]}
                tt_bitpos=$(( tt_gr * 3 + tt_gcol ))
                tt_bit=$(( ( tt_gi >> tt_bitpos ) & 1 ))
                if [ "$tt_bit" -eq 1 ]; then tt_on=1; fi
              fi
            fi
          fi
          if [ "$tt_on" -eq 1 ]; then
            # 70% outline over the background
            r=$(( (5 * 70 + r * 30) / 100 ))
            g=$(( (5 * 70 + g * 30) / 100 ))
            b=$(( (5 * 70 + b * 30) / 100 ))
            tt_done=1
          fi
        fi
        tt_cand=$(( tt_cand + 1 ))
      done
    fi
    emit
    x=$(( x + 1 ))
  done
  y=$(( y + 1 ))
done
stat_span "loop"
echo "texture-jpeg: ${SIZE}x${SIZE}, seed $TEX_SEED" >&2
finish
