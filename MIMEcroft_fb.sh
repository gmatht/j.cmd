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
#   # one frame to a PPM, no input needed (MIME_FRAMES unset = 1 frame):
#   /home/llm/sh2loop/bash-o4/target/debug/bash-O4 MIMEcroft_fb.sh
#   -> /tmp/mimecroft-fb.ppm
#
#   # SEE IT, rather than just writing a file:
#   MIME_VIEW=1 /home/llm/sh2loop/bash-o4/target/debug/bash-O4 MIMEcroft_fb.sh
#   MIME_VIEW=1 stops rewriting the image every frame and opens the
#   final one in a viewer (xdg-open, else feh), once, after the last
#   frame. WITHOUT it this program renders a maze, writes a PPM, and
#   exits — which on a machine with no /dev/fb0 is indistinguishable
#   from having done nothing at all.
#
#   There is no window to pop up on a box with no framebuffer, because
#   there is nothing to pop up: this host has fbcon and no /dev/fb0, so
#   the device draws into RAM. On a box that HAS one it mmaps the real
#   device, every frame lands on the display, and MIME_VIEW is neither
#   needed nor wanted.
#
#   # a native binary you can run on its own:
#   /home/llm/sh2loop/bash-o4/target/debug/bash-O4 -o ./mimecroft MIMEcroft_fb.sh
#   ./mimecroft
#
#   # PLAY IT, on a terminal, with the keyboard:
#   MIME_FRAMES=0 ./mimecroft
#   MIME_FRAMES=0 means NO frame budget: the loop runs until you press
#   `.` (quit). It used to mean "one frame", because frame 1 is already
#   >= 0 — so there was no way to start the game without a cap, and
#   the obvious way to run it could not be expressed. Leave MIME_FRAMES
#   unset and you still get exactly one frame, which is what a
#   screenshot wants.
#
#   A keyboard run wants a real terminal: it reads stdin in raw mode.
#   Redirect stdin, or use MIME_KEYS below, and the walk is scripted.
#
#   # script a walk (headless; one key per line in the key file):
#   printf 'w\nw\ne\nw\n' > /tmp/keys
#   MIME_FRAMES=6 MIME_KEYS=/tmp/keys MIME_OUT=/tmp/frame.ppm ./mimecroft
#
#   BASH_O4_SH2PERL is NOT needed for any of the above. The driver finds
#   the sh2perl runtime on its own, by walking up from its own path
#   looking for ../sh2perl/runtime/uu_run.c, so the commands above work
#   from any directory. Set it only when the binary has been COPIED out
#   of the tree, where that walk finds nothing and the error says so:
#
#     cannot locate sh2perl runtime (set $BASH_O4_SH2PERL)
#
#   It was in the header here because the first version of this file was
#   written when discovery was not noticed; a command line with an env
#   var nobody needs is a thing to copy for no reason.
#
# On a box with a real framebuffer, set FB0_DEV (default /dev/fb0) and
# the device mmaps it instead of dumping a PPM; the RAM + PPM path is
# the fallback, and is what runs where there is no /dev/fb0.
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
# fmt_pos: milli -> a plain world-unit string (MIMEcroft's fmt_pos).
# fmt3 sat next to this and was never called: it zero-pads an integer
# for a label, which fmt_pos does not and which the render has no use
# for. It is gone rather than left as a second way to format a number.
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
# MIME_VIEW=1: dump ONE image at the end and hand it to an image viewer,
# instead of rewriting it every frame. The default (0) keeps the
# per-frame dump, because a file that nothing opens is not a picture.
VIEW=${MIME_VIEW:-0}
# There was a SECONDS_BUDGET here, read from $MIME_SECONDS, and the
# loop never consulted it — a dead knob that looked like a wall-clock
# exit. Set it and nothing happened, which is worse than not having it.
# FRAMES is the budget that actually bounds a headless run, and an
# interactive run ends on the quit key or on Ctrl-C.
FOUND=0
MOVED=0
frame=0
quitting=0
restarting=0
ak_rc=0

# THE WORLD: a fresh maze, a fresh set of chests, and the player back
# at the start. A FUNCTION, because `r` restarts the run and has to be
# able to do all of this again.
#
# It cannot hold the DRAW, though: bash-O4 emits every function body
# ABOVE main(), so a draw inside one would run before the top-level
# fb_open and land on an unopened surface — which is why the first
# version of this rendered an empty frame. The rule for the file is
# that the DRAW stays at top level; building the world is not drawing,
# so it goes in a function, and the surface is opened first, above it.
#
# DEFINED BEFORE IT IS CALLED, which real bash requires. bash-O4 hoists
# function bodies so the transpiled build does not care, but the
# equivalence harness runs this same file under real bash, where a
# call above the definition is "command not found" — the reference
# side then reported "cell ," (an empty player position) for all 25
# cases while the native side was fine. A file that only ever runs
# through the transpiler can drift into shapes real bash rejects, and
# that suite is what catches it.
new_world() {
  # gen_maze FIRST: the treasure placement QUERIES the map with
  # get_cell, so a maze that has not been rolled yet leaves $gv empty
  # and every placement test fails (the shell reports "integer
  # expression expected", and there are zero treasures in the frame).
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
  dpcx_ms=$((px * 1000))
  dpcz_ms=$((pz * 1000))
  dpyw_ms=$((dyaw * 90000))
  # start facing +z (MIMEcroft's yaw 2)
  set_rot $((dyaw * 90))
  FOUND=0
  MOVED=0
}

fb_open $SCREEN_W $SCREEN_H

new_world

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

# walkable? a cell the player may enter.
#
# NB the two assignments: `ce_z=$1` (z from $1) was a typo that made
# the second one dead — the body went on to read the z it actually
# wanted from $2, so the bug was invisible here. It is still wrong on
# its face, and a variable named ce_z holding an x is the kind of thing
# the next person edits around.
#
# A TREASURE CELL IS ENTERABLE, and that is the whole point of it. The
# placement writes TREASURE into layer 1 of an otherwise-air cell, so a
# cell holding a treasure is NOT air and this test used to refuse it:
# the chest became a wall, the player could never reach one, and FOUND
# stayed 0 for the whole run — in every one of the 23 equivalence cases,
# which is why a game that can never be won looked fine. Upstream is
# explicit about the rule (www/bin/mimecroft.sh, try_move):
#
#   # a HIDDEN treasure is claimed by WALKING into it
#   if [ "$gv" -eq "$TREASURE" ]; then ... claim_treasure ...; return 0; fi
#
# So: air, or a treasure to claim.
can_enter() { ce_x=$1; ce_z=$2
  get_cell $1 1 $2
  if [ "$gv" -eq "$TREASURE" ]; then return 0; fi
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
      if [ "$gv" -eq "$TREASURE" ]; then
        FOUND=$((FOUND + 1))
        # THE CHEST IS DUG OUT ON CLAIM, as upstream does
        # (www/bin/mimecroft.sh:1041, "the recovered artifact is dug
        # out - the block vanishes so the label/radar stop showing
        # it"). Without this the cell stayed a TREASURE forever and the
        # player could step off it and back on to score as many "found"
        # as the frame budget allowed: FOUND counted CLAIMS, not
        # chests, and could exceed the four on the map. Removing the
        # cell is also what makes can_enter's treasure branch a
        # ONE-TIME event, which is why it needs no per-treasure found[]
        # flag of the kind upstream keeps.
        set_cell $px 1 $pz $AIR
      fi
    fi
  fi
  if [ "$ak" = "q" ]; then dyaw=$(( (dyaw + 3) % 4 )); fi
  if [ "$ak" = "e" ]; then dyaw=$(( (dyaw + 1) % 4 )); fi
  # `r` is "restart the RUN", not "reset the counters". It used to set
  # FOUND=0; MOVED=0 and leave the map alone, which restarted nothing
  # the player can see - the chests they had dug out stayed dug out and
  # the player stayed put. Returning 2 asks the loop to re-roll the
  # board; see new_world.
  if [ "$ak" = "r" ]; then return 2; fi
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
    apply_key "$rk"
    ak_rc=$?
    if [ "$ak_rc" -eq 1 ]; then
      quitting=1
    fi
    if [ "$ak_rc" -eq 2 ]; then
      restarting=1
    fi
  fi
  # A restart re-rolls the board and the player, so the frame drawn
  # below shows the new maze. It still draws this frame — clear plus a
  # render of the new world — so the screen is never left showing a
  # board the player has already walked off.
  if [ "$restarting" -eq 1 ]; then
    restarting=0
    new_world
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
  # The dump is what you LOOK at, so it is per frame by default. That
  # is 230 KB of write(2) per frame, which at 50 fps is 11 MB/s — real,
  # but it is the only I/O in the loop, and without it there is nothing
  # to see on a host with no /dev/fb0.
  #
  # MIME_VIEW=1 turns it off and hands the image to a viewer ONCE, at
  # the end. Not per frame: a refresh is a process, and this loop is
  # otherwise free of them (see the note on fb_input_line above), so
  # refreshing per frame would put a fork and an exec back on the hot
  # path — trading the thing that made the native build worth having.
  if [ "$VIEW" -eq 0 ]; then fb_dump_ppm "$OUT"; fi

  # the frame IS on screen; now honour a quit requested before it
  if [ "$quitting" -eq 1 ]; then break; fi
  # A budget of 0 (or less) means NO budget: the loop then runs until
  # the quit key or a signal. It used to mean "one frame", because
  # frame 1 is already >= 0, so there was no way to start the game
  # without a frame cap — the documented way to play it, with a live
  # keyboard and no key file, could not be expressed. The at-least-one-
  # frame behaviour is kept by testing the budget only when it is set,
  # so MIME_FRAMES unset still renders exactly one frame and exits,
  # which is what a screenshot wants.
  if [ "$FRAMES" -gt 0 ] && [ "$frame" -ge "$FRAMES" ]; then break; fi
done

echo "mimecroft-fb: $frame frames, cell $px,$pz yaw $((dyaw * 90)), $MOVED steps, $FOUND found"

# MIME_VIEW: one dump and one viewer, AFTER the loop. A real /dev/fb0
# needs none of this — the device is the display, fb_present already
# showed every frame, and $OUT is only a convenience. On a host with no
# framebuffer the PPM is the ONLY thing that exists to look at, and
# without this the program renders a maze, writes a file, and exits
# without ever showing it, which looks exactly like a crash.
#
# A viewer opens a window and then STAYS OPEN, so it blocks by design.
# Backgrounding it with a plain & is not enough here: the transpiled
# binary waits for every child, so a backgrounded viewer hangs the game
# forever with no output — which is a worse failure than the one this
# whole block exists to fix. "setsid --fork" double-forks, so the
# viewer is reparented to init and there is no child left to wait for.
# Verified: "feh ... &" never returns under bash-O4; "setsid --fork
# feh ..." returns at once, viewer up.
#
# Without setsid the honest thing is to print the path and NOT pretend:
# a viewer we cannot detach would either hang the game or be killed
# with it, and either way the user gets a command to run instead.
if [ "$VIEW" -eq 1 ]; then
  fb_dump_ppm "$OUT"
  launched=0
  # Writing this as "setsid --fork CMD && launched=1" is the natural
  # way and it is WRONG here, in two separate ways that happen to look
  # like one bug:
  #   * under bash-O4 the && assignment does not take the command's
  #     status, and "launched" comes back as an uninitialised register
  #     (measured: 123) instead of 1 — so the "it worked" flag is
  #     garbage and the branch that should have reported a viewer said
  #     nothing at all;
  #   * even in real bash it is the wrong signal, because
  #     "setsid --fork" exits 0 whether or not the command it forked
  #     exists or ran. "setsid --fork /nonexistent-xyz; echo $?"
  #     prints 0 in both shells. The parent reports that IT forked,
  #     nothing more.
  # So the flag records only that a tool was FOUND and was asked to
  # open the file; whether the viewer then appears is the viewer's
  # business, and a broken desktop association is not something this
  # program can or should adjudicate. The status is taken as its own
  # statement rather than as the right-hand side of `&&`, which is the
  # form that survives the transpiler.
  if command -v setsid > /dev/null 2>&1; then
    if command -v xdg-open > /dev/null 2>&1; then
      setsid --fork xdg-open "$OUT" > /dev/null 2>&1
      launched=1
    fi
    if [ "$launched" -eq 0 ] && command -v feh > /dev/null 2>&1; then
      setsid --fork feh "$OUT" > /dev/null 2>&1
      launched=1
    fi
  fi
  if [ "$launched" -eq 1 ]; then
    echo "mimecroft-fb: opened $OUT"
  else
    echo "mimecroft-fb: no setsid/xdg-open/feh to open it with."
    echo "mimecroft-fb: open it yourself:  feh $OUT   (or: xdg-open $OUT)"
  fi
fi

echo "mimecroft-fb: wrote $OUT"
