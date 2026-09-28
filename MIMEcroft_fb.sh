#!/bin/bash
# MIMEcroft_fb.sh — MIMEcroft on the fb0 framebuffer, compiled by
# bash-O4 to a native ELF. No WebGL, no browser, no bash in the draw
# loop.
#
# WHAT THIS IS
#   MIMEcroft's own render_frame (www/bin/MIMEcroft.sh:2144) driven
#   through the fb0 device: the same gen_maze (a drunkard's walk over
#   a 16x16x3 grid, obsidian border, carved corridors), the same
#   try_draw frustum cull, the same far-to-near cell walk per facing
#   axis, the same fmt_pos milli-to-world camera uniforms, and the
#   same "x y z sx sy sz r g b tx dam" block payload. Only the device
#   at the end of it changed: /dev/webgl/blocks -> fb_blocks.
#
#   Unlike native-mimecroft.sh (which renders ONE frame and exits),
#   this runs the game loop: walk the maze, find the treasure, and
#   re-render every frame, reading movement from a key file.
#
# HOW TO RUN
#   # one frame to a PPM (no input needed):
#   BASH_O4_SH2PERL=/home/llm/sh2loop/sh2perl \
#     /home/llm/sh2loop/bash-o4/target/debug/bash-O4 MIMEcroft_fb.sh
#
#   # a native binary you can run on its own:
#   bash-O4 -o mimecroft MIMEcroft_fb.sh && ./mimecroft
#
#   On a box with a real framebuffer, set FB0_DEV (default
#   /dev/fb0) and the device mmaps it instead of dumping a PPM; the
#   RAM + PPM path is the fallback, and is what runs where there is
#   no /dev/fb0.
#
# THE GAME LOOP
#   Controls come from the fbinput device (runtime/fbinput.h), which is
#   one non-blocking in-process read per frame — no fork, no exec, no
#   `head`/`tail`/`mv` per key:
#       w/a/s/d  move      q/e  turn left/right
#       r        restart   .    quit after the current frame
#   It reads $MIME_KEYS (a key file, one key per line) when that file
#   exists — that is how a headless run is scripted — and a real
#   keyboard (/dev/input/event*, or the terminal) when it does not, so
#   this file runs as a real game with no scripting at all.
#   One key per frame: a burst arriving between two frames is consumed
#   one key per frame, so a held key cannot teleport the player.
#   The loop also exits on a frame budget (MIME_FRAMES) so a headless
#   run always terminates.
#
# TWO PORT-SPECIFIC RULES (both learned the hard way)
#   1. The DRAW must not live in a shell function. bash-O4 emits every
#      function body ABOVE main(), so a draw inside one would run
#      before the top-level fb_open and land on an unopened surface —
#      which is why the first version of this rendered an empty frame.
#      The frame is therefore drawn from top-level statements.
#   2. The culling rotation (td_cs/td_sn) must follow the camera
#      heading, and is set ONCE PER FRAME, not per cell.

MAP_W=16
MAP_D=16
MAP_H=3
CELLS=$((MAP_W * MAP_D))
BOUND_X=$((MAP_W - 1))
BOUND_Z=$((MAP_D - 1))
RD_VR=16000

AIR=0
DIRT=1
STONE=2
OBSIDIAN=3
GOLD=4
DIAMOND=5
RUBY=6
TREASURE=7

SCREEN_W=320
SCREEN_H=240

# ─── world ────────────────────────────────────────────────────────
map=()
bhp=()
# CELLS ENTRIES IS NOT ENOUGH. set_cell/get_cell index the array by
#   b * CELLS + c * MAP_W + a
# where b is the LAYER (0, 1, 2), so the highest index is
#   2 * CELLS + (MAP_D-1) * MAP_W + (MAP_W-1) = 767, not 255.
# The arrays were only ever filled for i < CELLS, so every layer-1 and
# layer-2 cell read back EMPTY.
#
# Two things broke, and neither announced itself:
#   * get_cell returned "" for a solid cell, so the treasure placement
#     tests and the can_enter walk test compared "" against a number;
#   * try_draw's `bh` (the damage field) came back empty, so every cube
#     record had TEN fields where fb_blocks requires ELEVEN. The device
#     reads 11 strtods per record, so it ran off the end of one record
#     into the next and desynchronised the whole payload — the frame
#     came out a single flat grey in a stripe pattern, and every
#     equivalence case still "passed" because the reference replays the
#     same malformed payload through the same device.
MAP_N=$((MAP_H * CELLS))
i=0
while [ "$i" -lt "$MAP_N" ]; do
  map[$i]=0
  bhp[$i]=0
  i=$((i + 1))
done

set_cell() { a=$1; b=$2; c=$3; v=$4; idx=$((b * CELLS + c * MAP_W + a)); map[$idx]=$v; }
get_cell() { a=$1; b=$2; c=$3; idx=$((b * CELLS + c * MAP_W + a)); gv=${map[$idx]}; }

seed=20240812
nmrand() { rd_m=$1; seed=$(((seed * 48271) % 2147483647)); rv=$((seed % rd_m)); }

gen_maze() {
  gm_x=0
  while [ "$gm_x" -lt "$MAP_W" ]; do
    gm_z=0
    while [ "$gm_z" -lt "$MAP_D" ]; do
      set_cell $gm_x 0 $gm_z $DIRT
      set_cell $gm_x 1 $gm_z $STONE
      set_cell $gm_x 2 $gm_z $STONE
      gm_z=$((gm_z + 1))
    done
    gm_x=$((gm_x + 1))
  done
  gm_sx=1
  while [ "$gm_sx" -le 3 ]; do
    gm_sz=1
    while [ "$gm_sz" -le 3 ]; do
      set_cell $gm_sx 1 $gm_sz $AIR
      set_cell $gm_sx 2 $gm_sz $AIR
      gm_sz=$((gm_sz + 1))
    done
    gm_sx=$((gm_sx + 1))
  done
  gm_cx=2
  gm_cz=2
  gm_steps=0
  gm_total=$((MAP_W * MAP_D * 55 / 100))
  while [ "$gm_steps" -lt "$gm_total" ]; do
    set_cell $gm_cx 1 $gm_cz $AIR
    set_cell $gm_cx 2 $gm_cz $AIR
    nmrand 4
    if [ "$rv" -eq 0 ]; then gm_cx=$((gm_cx + 1)); fi
    if [ "$rv" -eq 1 ]; then gm_cx=$((gm_cx - 1)); fi
    if [ "$rv" -eq 2 ]; then gm_cz=$((gm_cz + 1)); fi
    if [ "$rv" -eq 3 ]; then gm_cz=$((gm_cz - 1)); fi
    if [ "$gm_cx" -lt 1 ]; then gm_cx=1; fi
    if [ "$gm_cx" -ge "$BOUND_X" ]; then gm_cx=$BOUND_X; fi
    if [ "$gm_cz" -lt 1 ]; then gm_cz=1; fi
    if [ "$gm_cz" -ge "$BOUND_Z" ]; then gm_cz=$BOUND_Z; fi
    gm_steps=$((gm_steps + 1))
  done
  gm_bx=$((MAP_W - 1))
  gm_bz=$((MAP_D - 1))
  gm_x=0
  while [ "$gm_x" -lt "$MAP_W" ]; do
    gm_z=0
    while [ "$gm_z" -lt "$MAP_D" ]; do
      if [ "$gm_x" -eq 0 ] || [ "$gm_x" -eq "$gm_bx" ] || [ "$gm_z" -eq 0 ] || [ "$gm_z" -eq "$gm_bz" ]; then
        set_cell $gm_x 0 $gm_z $OBSIDIAN
        set_cell $gm_x 1 $gm_z $OBSIDIAN
        set_cell $gm_x 2 $gm_z $OBSIDIAN
      fi
      gm_z=$((gm_z + 1))
    done
    gm_x=$((gm_x + 1))
  done
  gm_ci=$((MAP_W - 2))
  gm_x=1
  while [ "$gm_x" -le "$gm_ci" ]; do
    set_cell $gm_x 1 1 $AIR
    set_cell $gm_x 1 $gm_ci $AIR
    set_cell 1 1 $gm_x $AIR
    set_cell $gm_ci 1 $gm_x $AIR
    set_cell $gm_x 2 1 $AIR
    set_cell $gm_x 2 $gm_ci $AIR
    set_cell 1 2 $gm_x $AIR
    set_cell $gm_ci 2 $gm_x $AIR
    gm_x=$((gm_x + 1))
  done
}

# ─── try_draw: cull + colour + append, as in MIMEcroft.sh ──────────
blk_p=""

try_draw() {
  td_a=$1; td_b=$2; td_c=$3
  # the y=0 dirt floor is the bg plane, not per-cell cubes
  if [ "$td_b" -eq 0 ]; then return 1; fi
  td_gi=$((td_b * CELLS + td_c * MAP_W + td_a))
  gv=${map[$td_gi]}
  if [ "$gv" -eq "$AIR" ]; then return 1; fi
  td_ddx=$((td_a * 1000 - dpcx_ms))
  td_ddz=$((td_c * 1000 - dpcz_ms))
  if [ "$td_ddx" -lt 0 ]; then td_adx=$((0 - td_ddx)); else td_adx=$td_ddx; fi
  if [ "$td_ddz" -lt 0 ]; then td_adz=$((0 - td_ddz)); else td_adz=$td_ddz; fi
  if [ "$td_adx" -gt "$RD_VR" ]; then return 1; fi
  if [ "$td_adz" -gt "$RD_VR" ]; then return 1; fi
  td_w=$(( (td_ddx * td_sn - td_ddz * td_cs) / 1000 ))
  # abs() of the cull rotation. The form matters: `$(( 0 - x ))` hoisted
  # into a temp before the test, and an `if [ "$x" -lt 0 ]` whose var
  # the range analysis had typed uint16_t (so the test was constant-
  # false). Assigning the abs INSIDE the branches, from an unquoted
  # test, keeps both the type and the evaluation point correct — the
  # same values real bash computes.
  if [ $td_cs -lt 0 ]; then td_csa=$(( 0 - td_cs )); else td_csa=$td_cs; fi
  if [ $td_sn -lt 0 ]; then td_sna=$(( 0 - td_sn )); else td_sna=$td_sn; fi
  td_wext=$(( 500 * (td_csa + td_sna) / 1000 ))
  td_wfront=$(( td_w + td_wext ))
  if [ "$td_wfront" -le 0 ]; then return 1; fi
  td_rx=$(( (td_ddx * td_cs + td_ddz * td_sn) / 1000 ))
  if [ "$td_rx" -lt 0 ]; then td_arx=$((0 - td_rx)); else td_arx=$td_rx; fi
  td_fov=$(( td_w * 3 + 1000 ))
  if [ "$td_arx" -gt "$td_fov" ]; then return 1; fi
  if [ "$gv" -eq 1 ]; then cr=0.55; cg=0.35; cb=0.20
  elif [ "$gv" -eq 2 ]; then cr=0.55; cg=0.55; cb=0.58
  elif [ "$gv" -eq 3 ]; then cr=0.55; cg=0.50; cb=0.70
  elif [ "$gv" -eq 4 ]; then cr=0.95; cg=0.75; cb=0.10
  elif [ "$gv" -eq 5 ]; then cr=0.20; cg=0.85; cb=0.85
  elif [ "$gv" -eq 6 ]; then cr=0.85; cg=0.15; cb=0.20
  elif [ "$gv" -eq 7 ]; then cr=1.00; cg=1.00; cb=1.00
  else cr=1.00; cg=1.00; cb=1.00; fi
  if [ "$gv" -eq 2 ]; then tx=1
  elif [ "$gv" -eq 3 ]; then tx=10
  elif [ "$gv" -eq 4 ]; then tx=2
  elif [ "$gv" -eq 5 ]; then tx=3
  elif [ "$gv" -eq 6 ]; then tx=4
  elif [ "$gv" -eq 7 ]; then tx=15
  else tx=0; fi
  bh=${bhp[$td_gi]}
  blk_p="${blk_p}$td_a $td_b $td_c 1 1 1 $cr $cg $cb $tx $bh
"
  return 0
}

# ─── render_frame (inlined) ──────────────────────────────────
# bash-O4 emits function bodies above main(), so a draw inside a shell
# function would run before the top-level fb_open. The frame is drawn
# from top-level statements instead. The body below is render_frame's,
# verbatim.
# fmt_pos: milli -> a plain world-unit string (MIMEcroft's fmt_pos)
fmt3() { f3_v=$1; f3_s=$f3_v; if [ "$f3_v" -lt 10 ]; then f3_s="00$f3_v"; elif [ "$f3_v" -lt 100 ]; then f3_s="0$f3_v"; fi; fv3="$f3_s"; }
fmt_pos() { fp_ms=$1
  fp_neg=0
  if [ "$fp_ms" -lt 0 ]; then fp_neg=1; fp_ms=$((0 - fp_ms)); fi
  fp_i=$((fp_ms / 1000))
  fp_f=$((fp_ms % 1000))
  fp_fs=$fp_f
  if [ "$fp_f" -lt 10 ]; then fp_fs="00$fp_f"; elif [ "$fp_f" -lt 100 ]; then fp_fs="0$fp_f"; fi
  if [ "$fp_neg" -eq 1 ]; then fv="-$fp_i.$fp_fs"; else fv="$fp_i.$fp_fs"; fi
}

# ─── game state ─────────────────────────────────────────────────
KEYS=${MIME_KEYS:-/tmp/mimecroft-keys}
OUT=${MIME_OUT:-/tmp/mimecroft-fb.ppm}
FRAMES=${MIME_FRAMES:-1}
SECONDS_BUDGET=${MIME_SECONDS:-0}
FOUND=0
MOVED=0
frame=0
quitting=0

# world setup. The surface must exist before any draw: bash-O4 emits
# the function bodies above main(), so a draw inside a function would
# run against an unopened surface.
fb_open $SCREEN_W $SCREEN_H

# gen_maze FIRST: the treasure placement below QUERIES the map with
# get_cell, so a maze that has not been rolled yet leaves $gv empty
# and every placement test fails (`[: : integer expression expected`,
# zero treasures in the frame).
gen_maze

# place the treasures so the frame has the white chests in it
tp=0
while [ "$tp" -lt 4 ]; do
  tries=0
  while [ "$tries" -lt 100 ]; do
    nmrand 14
    rx=$((rv + 1))
    nmrand 14
    rz=$((rv + 1))
    get_cell $rx 1 $rz
    if [ "$gv" -eq "$AIR" ]; then
      get_cell $rx 2 $rz
      if [ "$gv" -eq "$AIR" ]; then
        set_cell $rx 1 $rz $TREASURE
        break
      fi
    fi
    tries=$((tries + 1))
  done
  tp=$((tp + 1))
done

# the player, the camera heading, and the camera uniforms — the same
# milli-encoding MIMEcroft uses (dpc*_ms is the camera cell x1000).
px=2
pz=2
dyaw=2
dpcx_ms=2000
dpcz_ms=2000
dpyw_ms=180000

# The culling rotation, per MIMEcroft's SCOS/SSIN tables
# (degree -> per-mille cos/sin).
#
# It writes the RENDERER's variables directly (td_cs / td_sn), not a
# separate rd_cs / rd_sn pair that something else is supposed to copy.
# The first version of this port had set_rot set rd_cs/rd_sn and the
# renderer read td_cs/td_sn, so the per-frame `set_rot` call updated a
# pair nobody read: the cull ran with a stale rotation for the whole
# run. The two sides then disagreed on 12 of 250 cubes per frame —
# and in REAL BASH the stale value was the EMPTY string, so the
# integer comparisons in try_draw silently took the other branch. The
# renderer and the setter must name the same variables.
set_rot() { rd_deg=$1
  if [ "$rd_deg" -eq 0 ]; then td_cs=1000; td_sn=0; fi
  if [ "$rd_deg" -eq 90 ]; then td_cs=0; td_sn=1000; fi
  if [ "$rd_deg" -eq 180 ]; then td_cs=-1000; td_sn=0; fi
  if [ "$rd_deg" -eq 270 ]; then td_cs=0; td_sn=-1000; fi
}
# start facing +z (MIMEcroft's yaw 2)
td_cs=-1000
td_sn=0

# NOTE ON read_key: this used to be a shell FUNCTION that set `rk` and
# returned. bash-O4 emits function bodies above main() and frees the
# function's locals on exit, so the caller read freed heap and every
# key came back empty (0 steps for 3 queued moves). The key is read at
# TOP LEVEL in the loop below for the same reason the draw is: a
# function boundary here costs a use-after-free.

# walkable? a cell the player may enter (the two body layers, both air).
# NB the two assignments: `ce_z=$1` (z from $1) was a typo that made
# the second one dead — the body went on to read the z it actually
# wanted from $2, so the bug was invisible here. It is still wrong on
# its face, and a variable named ce_z holding an x is the kind of thing
# the next person edits around.
can_enter() { ce_x=$1; ce_z=$2
  get_cell $1 1 $2
  if [ "$gv" -ne "$AIR" ]; then return 1; fi
  get_cell $1 2 $2
  if [ "$gv" -ne "$AIR" ]; then return 1; fi
  return 0
}

apply_key() { ak=$1
  # NB on the shape: the original used a `case` whose pattern list was
  # w|a|s|d, which lowers to ONE fnmatch against the FIRST alternative
  # only (the C emitted fnmatch("w", ak, 0)) — so q/e/r/. were
  # unreachable and only "w" ever acted. Each key is tested on its own
  # line here.
  #
  # The step table is MIMEcroft's own: yaw 0 faces -z, 1 faces +x,
  # 2 faces +z, 3 faces -x, and w/a/s/d are forward/left/back/right.
  if [ "$ak" = "w" ] || [ "$ak" = "a" ] || [ "$ak" = "s" ] || [ "$ak" = "d" ]; then
    nx=$px
    nz=$pz
    if [ "$ak" = "w" ]; then
      if [ "$dyaw" -eq 0 ]; then nz=$((pz - 1))
      elif [ "$dyaw" -eq 1 ]; then nx=$((px + 1))
      elif [ "$dyaw" -eq 2 ]; then nz=$((pz + 1))
      else nx=$((px - 1)); fi
    fi
    if [ "$ak" = "s" ]; then
      if [ "$dyaw" -eq 0 ]; then nz=$((pz + 1))
      elif [ "$dyaw" -eq 1 ]; then nx=$((px - 1))
      elif [ "$dyaw" -eq 2 ]; then nz=$((pz - 1))
      else nx=$((px + 1)); fi
    fi
    if [ "$ak" = "a" ]; then
      if [ "$dyaw" -eq 0 ]; then nx=$((px - 1))
      elif [ "$dyaw" -eq 1 ]; then nz=$((pz - 1))
      elif [ "$dyaw" -eq 2 ]; then nx=$((px + 1))
      else nz=$((pz + 1)); fi
    fi
    if [ "$ak" = "d" ]; then
      if [ "$dyaw" -eq 0 ]; then nx=$((px + 1))
      elif [ "$dyaw" -eq 1 ]; then nz=$((pz + 1))
      elif [ "$dyaw" -eq 2 ]; then nx=$((px - 1))
      else nz=$((pz - 1)); fi
    fi
    if [ "$nx" -ge 1 ] && [ "$nx" -le "$BOUND_X" ] && \
       [ "$nz" -ge 1 ] && [ "$nz" -le "$BOUND_Z" ] && can_enter $nx $nz; then
      px=$nx
      pz=$nz
      MOVED=$((MOVED + 1))
      get_cell $px 1 $pz
      if [ "$gv" -eq "$TREASURE" ]; then FOUND=$((FOUND + 1)); fi
    fi
  fi
  if [ "$ak" = "q" ]; then dyaw=$(( (dyaw + 3) % 4 )); fi
  if [ "$ak" = "e" ]; then dyaw=$(( (dyaw + 1) % 4 )); fi
  if [ "$ak" = "r" ]; then FOUND=0; MOVED=0; fi
  if [ "$ak" = "." ]; then return 1; fi
  return 0
}

# ─── the loop ───────────────────────────────────────────────────
# (gen_maze already ran, above the treasure placement: the maze is the
# level, and re-rolling it per frame would make the walk incoherent.)

while :; do
  frame=$((frame + 1))


  # One queued key per frame (empty queue = just re-render).
  #
  # INPUT IS A DEVICE CALL, NOT A SHELL PIPE. This used to be
  #
  #     rk=$(head -n 1 "$KEYS")
  #     [ -n "$rk" ] && { tail -n +2 "$KEYS" > "$KEYS.rest"; mv "$KEYS.rest" "$KEYS"; }
  #
  # which is three processes PER FRAME: a fork, an exec and a wait for
  # every single key, on the hot path of a game loop. The fbinput
  # device (runtime/fbinput.h) answers the same question with one
  # non-blocking in-process read, and it also reads a real keyboard
  # (evdev, or the terminal) when $KEYS names no queue — this file no
  # longer needs the game to be scripted at all.
  #
  # $KEYS IS PASSED AS AN ARGUMENT, not exported. An `export` in a
  # transpiled program becomes a plain C assignment — the render never
  # calls setenv — so a C device reading the environment would see
  # whatever the process was started with and the game would silently
  # never receive a key (0 steps, every walk, while the same script
  # under real bash was fine). An argument keeps the queue in the
  # program's own data.
  #
  # The read is at TOP LEVEL, for the reason in the note above the
  # loop: a shell function that sets `rk` and returns gets its locals
  # freed on exit, and the caller then reads freed heap — every key
  # came back empty (0 steps for 3 queued moves).
  rk=$(fb_input_line "$KEYS")
  # A quit (`.`) must still leave ONE frame on screen. Breaking out
  # here, before the first draw, produced a run that wrote no PPM at
  # all — a quit as the very first key left the program with no output
  # whatsoever, which is indistinguishable from a crash.
  if [ -n "$rk" ]; then
    if ! apply_key "$rk"; then
      quitting=1
    fi
  fi

  # Clear after the input, every frame. Two rules in one:
  #  - INSIDE the loop: outside, a single-frame script paints over
  #    itself and a walk smears ghosts of every cell behind the camera
  #    instead of showing the current view;
  #  - AFTER the key: a quit key ('.') breaks out BEFORE the clear, so
  #    the last drawn frame survives instead of being wiped to black.
  fb_clear 4278190080

  # camera uniforms follow the player cell (MIMEcroft's own convention:
  # the eye sits at the player cell's CENTRE, half a block up)
  dpcx_ms=$((px * 1000))
  dpcz_ms=$((pz * 1000))
  case "$dyaw" in
    0) dpyw_ms=0 ;;
    1) dpyw_ms=90000 ;;
    2) dpyw_ms=180000 ;;
    *) dpyw_ms=270000 ;;
  esac
  # ...and the culling rotation must match that heading.
  set_rot $((dyaw * 90))

  # ─── render_frame: one full native frame ─────────────────────
  blk_p=""
  fmt_pos $dpcx_ms
  cxs=$fv
  fmt_pos $dpcz_ms
  czs=$fv
  fmt_pos $dpyw_ms
  ywd=$fv
  cys=0.9
  fb_set_camera $cxs $cys $czs $ywd 0

  # the four quadrant floor/ceiling planes (the background layer)
  bg_p=""
  qp0=$((px * 1000))
  qpz0=$((pz * 1000))
  qd=1
  while [ "$qd" -le 4 ]; do
    if [ "$qd" -eq 1 ]; then qdx=10000; qdz=10000; fi
    if [ "$qd" -eq 2 ]; then qdx=10000; qdz=-10000; fi
    if [ "$qd" -eq 3 ]; then qdx=-10000; qdz=10000; fi
    if [ "$qd" -eq 4 ]; then qdx=-10000; qdz=-10000; fi
    qpx=$((qp0 + qdx))
    qpz=$((qpz0 + qdz))
    fmt_pos $qpx
    qfx=$fv
    fmt_pos $qpz
    qfz=$fv
    bg_p="${bg_p}$qfx 0.45 $qfz 20 0.1 20 1 1 1 8 0
"
    bg_p="${bg_p}$qfx 2.05 $qfz 20 0.1 20 0.24 0.24 0.28 0 0
"
    qd=$((qd + 1))
  done
  fb_blocks "$bg_p"

  # the culled maze cubes, far-to-near along the facing axis
  if [ "$dyaw" -eq 0 ]; then
    rf_z=0
    while [ "$rf_z" -lt "$MAP_D" ]; do
      rf_x=0
      while [ "$rf_x" -lt "$MAP_W" ]; do
        try_draw $rf_x 1 $rf_z
        try_draw $rf_x 2 $rf_z
        rf_x=$((rf_x + 1))
      done
      rf_z=$((rf_z + 1))
    done
  fi
  if [ "$dyaw" -eq 1 ]; then
    rf_x=$BOUND_X
    while [ "$rf_x" -ge 0 ]; do
      rf_z=0
      while [ "$rf_z" -lt "$MAP_D" ]; do
        try_draw $rf_x 1 $rf_z
        try_draw $rf_x 2 $rf_z
        rf_z=$((rf_z + 1))
      done
      rf_x=$((rf_x - 1))
    done
  fi
  if [ "$dyaw" -eq 2 ]; then
    rf_z=$BOUND_Z
    while [ "$rf_z" -ge 0 ]; do
      rf_x=0
      while [ "$rf_x" -lt "$MAP_W" ]; do
        try_draw $rf_x 1 $rf_z
        try_draw $rf_x 2 $rf_z
        rf_x=$((rf_x + 1))
      done
      rf_z=$((rf_z - 1))
    done
  fi
  if [ "$dyaw" -eq 3 ]; then
    rf_x=0
    while [ "$rf_x" -lt "$MAP_W" ]; do
      rf_z=0
      while [ "$rf_z" -lt "$MAP_D" ]; do
        try_draw $rf_x 1 $rf_z
        try_draw $rf_x 2 $rf_z
        rf_z=$((rf_z + 1))
      done
      rf_x=$((rf_x + 1))
    done
  fi
  fb_blocks "$blk_p"
  fb_present
  fb_dump_ppm "$OUT"

  # the frame IS on screen; now honour a quit requested before it
  if [ "$quitting" -eq 1 ]; then break; fi
  if [ "$frame" -ge "$FRAMES" ]; then break; fi
done

echo "mimecroft-fb: $frame frames, cell $px,$pz yaw $((dyaw * 90)), $MOVED steps, $FOUND found"
echo "mimecroft-fb: wrote $OUT"
