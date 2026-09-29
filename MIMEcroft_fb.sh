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
# THE VIRTUAL FRAMEBUFFER
#   fb_present is not "write a file at the end". On a box with no
#   /dev/fb0 it opens a REAL X11 WINDOW (runtime/fbwin.c, which
#   dlopen()s libX11 so nothing here needs an X11 header to build) and
#   every frame is blitted into it as it is drawn. So the default run:
#
#     bash-O4 -o ./mimecroft MIMEcroft_fb.sh
#     ./mimecroft
#
#   gives a 320x240 window titled "MIMEcroft (fb0)" with the maze in
#   it, updating as you walk. No browser, no WebGL, no image viewer,
#   and no "it rendered something and exited".
#
#   The knobs, which is the one thing here that was genuinely wrong
#   before: a window is the DEFAULT, so MIME_WINDOW is the OFF switch.
#     (unset)        window + a PPM rewritten every frame
#     MIME_WINDOW=0  no window, PPM only. What a box with no X wants.
#     MIME_VIEW=1    window only; no per-frame PPM (that write is
#                    230 KB per frame, and on a window it is dead I/O)
#   $FBWIN=0 is the device's own off switch (runtime/fbwin.h) and
#   outranks MIME_WINDOW. MIME_WINDOW=0 is the honest way to ask for
#   that here: the sh2 runtime is linked into whatever transpiles
#   this, the two settings live in different files, and a knob whose
#   effect depends on which one happens to be read last is a knob
#   nobody can rely on. The equivalence harness sets MIME_WINDOW=0
#   for exactly that reason, so its 25 headless cases do not open 25
#   windows.
#
#   $DISPLAY picks the server. Unset, or refusing the connection, the
#   device falls back to RAM + PPM and says so once. Nothing about the
#   GAME changes either way: same world, same camera, same payload.
#
# HOW TO RUN
#   # play it, in a window, with the keyboard (this is the default):
#   /home/llm/sh2loop/bash-o4/target/debug/bash-O4 -o ./mimecroft MIMEcroft_fb.sh
#   ./mimecroft
#   -> a window. w/a/s/d move, q/e turn, r restarts, . or Esc quits.
#
#   # headless: one frame to a PPM, no window, no input needed
#   # (MIME_FRAMES unset = 1 frame):
#   MIME_WINDOW=0 /home/llm/sh2loop/bash-o4/target/debug/bash-O4 MIMEcroft_fb.sh
#   -> /tmp/mimecroft-fb.ppm
#
#   # a native binary you can run on its own:
#   /home/llm/sh2loop/bash-o4/target/debug/bash-O4 -o ./mimecroft MIMEcroft_fb.sh
#   ./mimecroft
#
#   # PLAY IT, on a terminal, with the keyboard:
#   MIME_FRAMES=0 ./mimecroft
#   MIME_FRAMES=0 means NO frame budget: the loop runs until you press
#   `.` (quit) or Escape, or close the window. It used to mean "one
#   frame", because frame 1 is already >= 0 — so there was no way to
#   start the game without a cap, and the obvious way to run it could
#   not be expressed. Leave MIME_FRAMES unset and you still get
#   exactly one frame, which is what a screenshot wants.
#
#   A keyboard run wants a real terminal: it reads stdin in raw mode.
#   Redirect stdin, or use MIME_KEYS below, and the walk is scripted.
#   With a window open the keys come from the X server instead, through
#   the same key names, so the game's own key handling is unchanged.
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
# the device mmaps it; no window is opened and the PPM is a side effect.
# With no framebuffer the window is the display.
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
# MIME_WINDOW is the OFF switch, because a window is the DEFAULT now.
# It used to be MIME_VIEW as the ON switch, which meant the thing you
# got with no environment at all was a file and no picture — and the
# very first command in this file's own header rendered a maze and
# exited, which is indistinguishable from a crash.
WINDOW=${MIME_WINDOW:-1}
# MIME_VIEW=1 now means the OTHER thing: window only, no per-frame PPM
# file. The dump is 230 KB of write(2) per frame, which is dead I/O
# once the frame is on a window, and a loop that spends a quarter of
# its time writing a file nobody looks at is not the loop this port
# was for. It is kept as a distinct knob rather than folded into
# MIME_WINDOW because "no window but still dump every frame" and
# "window but stop writing files" are two different requests.
VIEW=${MIME_VIEW:-0}
# A window that cannot be opened is not a failure — the device falls
# back to RAM + PPM — but it must not be SILENT, because "it just
# died" and "it ran and showed you nothing" look the same from outside.
# The loop says which surface it got before the first frame, so "no
# window and no line" means the program died while "no window, RAM+PPM"
# means it ran and told you where to look.
#
# THE NESTED IF IS THE SHAPE OF THE TRUTH, and folding it into one
# condition would be shorter and wrong. VIEW=1 means "the window is the
# picture", which is only true if there IS a window: asked for with
# MIME_WINDOW=0, it is two contradictory requests, and the file is the
# one that must win because it is the one that still exists afterwards.
# Written as "WINDOW=0 or VIEW=1, and no PPM iff VIEW=1", the second
# clause fires on a request that asked for no window at all.
WANT_PPM=1
if [ "$WINDOW" -eq 0 ]; then
  WANT_PPM=1
elif [ "$VIEW" -eq 1 ]; then
  WANT_PPM=0
fi
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

# Say ONCE, on stdout, which surface the frames are going to. A window
# that silently fails to open is indistinguishable from a game that
# never ran, and this line is the difference: it is printed before the
# first frame, so "no window and no line" means the program died, while
# "no window, RAM+PPM" means it ran and told you where to look.
#
# IT IS AN IF, NOT A CONDITIONAL CALL. Written as
#
#     if fb_window_open; then echo "window ..."; else echo "no window"; fi
#
# the else branch is correct in real bash and WRONG under bash-O4: it
# ran even with MIME_WINDOW=0, so the program claimed a window on a
# run that had asked for none and opened one, and the equivalence
# suite's own "no window per case" turned into 25 windows on a
# desktop. Asking the DEVICE here makes the device call itself part of
# the question, and fb_window_open's own $FBWIN switch is the right
# place for the question. The knob is still honoured: a run that wants
# no window says so before the device is asked, not after.
if [ "$WINDOW" -eq 0 ]; then
  echo "mimecroft-fb: no window (MIME_WINDOW=0); frames go to $OUT"
elif fb_window_open; then
  echo "mimecroft-fb: window $SCREEN_W x $SCREEN_H on ${DISPLAY:-<no DISPLAY>} - w/a/s/d move, q/e turn, r restart, . or Esc quit"
else
  echo "mimecroft-fb: no window (no X display); frames go to $OUT"
fi

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
  # The WINDOW is a key source too, and it is checked first. It has to
  # be: fbinput's own sources are the key file, then evdev, then the
  # terminal, and on a box that has an X display it usually also has a
  # keyboard on stdin that a harness is not typing into. A person
  # pressing 'w' at the window would be reading a terminal nobody
  # watches.
  #
  # X first is also the only order that does not lose keys: fbinput
  # would otherwise consume a key the moment it appeared and the window
  # would never see it, so with the window in front, whichever device
  # produced the key is the one that acts.
  #
  # Both calls translate to the SAME game key names, and the game below
  # is unchanged, which is the point of a device: the source changes,
  # the control code does not.
  wk=$(fb_window_key)
  if [ -n "$wk" ]; then rk=$wk; fi
  # A CLOSED WINDOW IS A QUIT, and not noticing it is the last way this
  # can look like a crash. Without this, closing the window leaves the
  # loop running against a window nobody is looking at, spinning a
  # frame budget or forever, with the player's last view frozen. The
  # game's own `.` key does the same thing, so the window's close is
  # expressed as the key the game already handles.
  if fb_window_closed; then rk="."; fi
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
  # fb_present blits the frame to the window when there is one, and is
  # a no-op on RAM. It was `return 0` with a comment saying the display
  # was somebody else's problem, which is true on a box with a
  # /dev/fb0 and false everywhere else: without a window there was no
  # frame on screen at any point in the run.
  fb_present
  # The per-frame PPM is now a SECOND copy of the picture, not the only
  # one. It is still on by default (a file nobody opens is not a
  # picture, and the headless case has no other output) and off under
  # MIME_VIEW=1, where the window is the picture.
  if [ "$WANT_PPM" -eq 1 ]; then fb_dump_ppm "$OUT"; fi

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

# The window closes itself: the device's exit hook unmaps it and frees
# the X image, so a game that ends leaves no orphan window on the
# server. There is deliberately no fb_window_close call here for a
# normal exit — an explicit close before the program's own exit-time
# output runs would race it, and atexit is the right owner of "the
# window outlives nothing".

if [ "$WANT_PPM" -eq 1 ]; then
  echo "mimecroft-fb: wrote $OUT"
else
  echo "mimecroft-fb: no PPM written (MIME_VIEW=1); the window had the frame"
fi
