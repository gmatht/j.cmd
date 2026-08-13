#!/usr/bin/env sh2perl
# ─────────────────────────────────────────────────────────────────────────
# mimecroft.sh — a 3D maze treasure hunt written in bash.
#
# You are a lost shell command inside a corrupted filesystem. Dig through
# a maze of coloured data blocks, recover the lost Operating Systems
# (GNU Hurd, Linux, FreeBSD, ...) and destroy the evil MIMEs that hunt
# you (image/jpeg, image/png, application/octet-stream, text/plain).
#
# Controls:  WASD move · ←/→ turn · SPACE shoot · Q quit
#
# The y=0 layer is a solid dirt floor (never mined); mining breaks the
# y=1 wall block — a mined passage is the same 1-tall opening as a
# corridor, so the eye stays at standing height throughout.
#
# Renders through the /dev/webgl device (src/fs/webgldev.js) and plays
# notes through /dev/audio (audiodev.js). Runs in the browser via the
# sh2perl transpiler and headless in the Node CLI (NullGL device).
#
# Language discipline (verified against bash2js + sh2runtime):
#   • arrays are declared with a literal (name=(...)) before any element
#     write; indices are precomputed scalar variables
#   • function args are copied to PREFIXED named variables before any use
#     — $1 inside $(( )) or [ ] becomes the literal digit 1 in this
#     pipeline, and `local` does not exist, so scratch names are unique
#     per function (shared globals would clobber each other)
#   • $(( ... )) is never inlined inside echo strings or test brackets
#   • no local / no $RANDOM / no C-style for — while loops only
# ─────────────────────────────────────────────────────────────────────────

# ─── World configuration ───────────────────────────────────────────
MAP_W=16
MAP_D=16
MAP_H=3
CELLS=$((MAP_W * MAP_D))          # 256 cells per level
# the walkable area is 1..W-2 (the border is wall) — precomputed bounds
BOUND_X=$((MAP_W - 1))            # 15 — the first rejected column
BOUND_Z=$((MAP_D - 1))            # 15 — the first rejected row
# the DISPLAY window: the world is 16x16 but only ~8x8 cells render at a
# time (the draw radius — 4 cells each way around the player; the floor/
# ceiling planes follow the camera so the view is a bounded patch)
VIEW_W=4
VIEW_R=16                         # draw radius — the whole 16x16 map (displayed at 50% scale)
RADAR_X=80                        # radar x base (milli-NDC) — the map sits top-LEFT
# ─── settings (editable in the pre-game menu; browser only) ────────
cam_shift_ms=0        # camera right shift (milli-NDC, ±50 per press, no limit) — 0 = the centred view; the old 500 (a quarter-screen right shift) moved the vanishing point off-centre
tex_size=16           # texture resolution (4/8/16/32/64 px)
tex_seed=20240812     # texture generation seed (drives the LCG noise)
sm_sel=0              # settings-menu cursor (0=shift 1=size 2=seed)
sm_done=0
sm_changed=0
headless=1            # set from /dev/webgl/state in main()
RANGE=12                          # shoot range
TREASURE_TOTAL=10
MIME_CAP=12
MIME_STEP=15          # mimes step every N frames (~6.7/sec — calmer view)
MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable
CRT_ON=0               # 1 = CRT scanlines + vignette on the rendered view; set 0 for a clean picture
CORRUPT_ON=0           # 1 = random corruption streaks on the view; set 0 to disable

# block ids
AIR=0
DIRT=1
STONE=2
OBSIDIAN=3
GOLD=4
DIAMOND=5
RUBY=6
TREASURE=7

# facing vectors and camera yaw (degrees) indexed by yaw 0..3
# yaw 0 → -z, 1 → +x, 2 → +z, 3 → -x   (matches the shader's rotation)
DIR_X=(0 1 0 -1)
DIR_Z=(-1 0 1 0)
CAM_YAW=(0 90 180 270)

# the lost operating systems
TREASURES=("GNU Hurd" "Linux" "FreeBSD" "NetBSD" "OpenBSD" "Plan 9" "Minix" "Solaris" "macOS Darwin" "Unix")

# mime damage by type: 1=jpeg 2=png 3=octet-stream 4=text/plain
MIME_DMG=(0 2 1 1 1)

# ─── World arrays ───────────────────────────────────────────────────
# map[i] and bhp[i], i = y*CELLS + z*MAP_W + x   (768 cells: 3 levels)
map=(0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0)
bhp=(0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0)
# treasure placements (10)
tpx=(0 0 0 0 0 0 0 0 0 0)
tpz=(0 0 0 0 0 0 0 0 0 0)
# mime entity arrays (parallel, capacity MIME_CAP)
mx=(0 0 0 0 0 0 0 0 0 0 0 0)
mz=(0 0 0 0 0 0 0 0 0 0 0 0)
my=(0 0 0 0 0 0 0 0 0 0 0 0)
mtype=(0 0 0 0 0 0 0 0 0 0 0 0)
mhp=(0 0 0 0 0 0 0 0 0 0 0 0)
# found artifacts (10)
found=(0 0 0 0 0 0 0 0 0 0)

# ─── Player / game state ────────────────────────────────────────────
px=2
pz=2
yaw=0
hp=10
maxhp=10
score=0
found_count=0
mime_count=0
frame=0
quit=0
sound=1
anim=0              # 1 while an action glides the camera
anim_t0=0           # wall-clock ms when the current glide started
ANIM_MS=200         # each action completes in 0.2s of wall time
ANIM_MS_CROUCH=400  # a move through a 1-tall (mined) passage — half speed
anim_ms=200         # the CURRENT glide's duration (moves slow when crouched)
crouched=0          # 1 when the ceiling overhead is low — the eye ducks
ax0=0; az0=0; ay0=0; ax1=0; az1=0; ay1=0; anim_ayd=0
fps=0               # rendered frames/sec (measured over ~10-frame windows)
fps_t0=0
fps_rendered=0
muzzle=0            # muzzle-flash lifetime (loop frames remaining)
dpyw_raw_ms=0       # unwrapped yaw arc (can be negative) for the radar
# triangle to take the short path while the shader uniform stays positive
seed=20240812

# ─── Shared helper outputs (set by the helpers below, read by caller
#     immediately after the call — never reused as scratch by the helper):
#     gv=cell value  bh=block hits  h=hardness  cr/cg/cb=colour
#     mf=1 if mime at cell  mt=mime type  rv=random  av=abs  cs=can step
# ────────────────────────────────────────────────────────────────────
rand() { rd_m=$1; seed=$(((seed * 48271) % 2147483647)); rv=$((seed % rd_m)); }

abs() { ab_v=$1; if [ "$ab_v" -lt 0 ]; then ab_v=$((0 - ab_v)); fi; av=$ab_v; }

# cell access — the flat index (y*CELLS + z*MAP_W + x) is computed by
# the caller and passed as an ARG to the store helpers. `$1` arg copies
# are always runtime-store writes, so `map[$mi]` reads them back
# correctly; a plain `idx=$((…))` can be hoisted into a JS `let` the
# store-read string can't see, and `idx=$(fn …)` command substitution
# hits a broken captureSync in the shell's transpiler — arguments dodge
# both traps.
map_set() { mi=$1; mv=$2; map[$mi]=$mv; bhp[$mi]=0; }
map_get() { gi=$1; gv=${map[$gi]}; }
bhp_get() { gi=$1; bh=${bhp[$gi]}; }
bhp_inc() { gi=$1; old=${bhp[$gi]}; bhp[$gi]=$((old + 1)); }

set_cell() { a=$1; b=$2; c=$3; v=$4; idx=$((b * CELLS + c * MAP_W + a)); map_set $idx $v; }
get_cell() { a=$1; b=$2; c=$3; idx=$((b * CELLS + c * MAP_W + a)); map_get $idx; }
get_bhp() { a=$1; b=$2; c=$3; idx=$((b * CELLS + c * MAP_W + a)); bhp_get $idx; }
add_bhp() { a=$1; b=$2; c=$3; idx=$((b * CELLS + c * MAP_W + a)); bhp_inc $idx; }

# block hardness by type (hits to destroy)
hardness() { hd_t=$1; case $hd_t in
  2) h=2 ;;
  3) h=3 ;;
  5) h=2 ;;
  6) h=2 ;;
  *) h=1 ;;
esac; }

block_color() { bc_t=$1; case $bc_t in
  1) cr=0.55; cg=0.35; cb=0.20 ;;
  2) cr=0.55; cg=0.55; cb=0.58 ;;
  3) cr=0.55; cg=0.50; cb=0.70 ;;
  4) cr=0.95; cg=0.75; cb=0.10 ;;
  5) cr=0.20; cg=0.85; cb=0.85 ;;
  6) cr=0.85; cg=0.15; cb=0.20 ;;
  7) cr=0.20; cg=1.00; cb=0.45 ;;
  *) cr=1.00; cg=1.00; cb=1.00 ;;
esac; }

mime_color() { mc_t=$1; case $mc_t in
  1) cr=0.95; cg=0.55; cb=0.15 ;;
  2) cr=0.20; cg=0.75; cb=0.25 ;;
  3) cr=0.65; cg=0.65; cb=0.65 ;;
  4) cr=0.90; cg=0.90; cb=0.90 ;;
  *) cr=1.00; cg=0.00; cb=0.00 ;;
esac; }

# sound — off in the headless Node device (no Web Audio)
play() { pl_note=$1; if [ "$sound" -eq 1 ]; then echo "$pl_note" > /dev/audio/note; fi; }

# ─── Mimes ───────────────────────────────────────────────────────────
mime_at() { ma_a=$1; ma_b=$2; mf=0; mt=0; ma_i=0
  while [ "$ma_i" -lt "$mime_count" ]; do
    ma_ex=${mx[$ma_i]}
    ma_ez=${mz[$ma_i]}
    if [ "$ma_ex" -eq "$ma_a" ] && [ "$ma_ez" -eq "$ma_b" ]; then mf=1; mt=${mtype[$ma_i]}; fi
    ma_i=$((ma_i + 1))
  done
}

kill_mime_at() { ka_a=$1; ka_b=$2; ka_i=0
  while [ "$ka_i" -lt "$mime_count" ]; do
    ka_ex=${mx[$ka_i]}
    ka_ez=${mz[$ka_i]}
    if [ "$ka_ex" -eq "$ka_a" ] && [ "$ka_ez" -eq "$ka_b" ]; then
      score=$((score + 5))
      ka_last=$((mime_count - 1))
      mx[$ka_i]=${mx[$ka_last]}
      mz[$ka_i]=${mz[$ka_last]}
      my[$ka_i]=${my[$ka_last]}
      mtype[$ka_i]=${mtype[$ka_last]}
      mhp[$ka_i]=${mhp[$ka_last]}
      # the radar/label prev cells move with the swapped mime
      rmx[$ka_i]=${rmx[$ka_last]}
      rmz[$ka_i]=${rmz[$ka_last]}
      mime_count=$ka_last
      hud_static_dirty=1
      play "G5 0.08"
      echo "  MIME sanitised  +5  ($mime_count left)"
      return 0
    fi
    ka_i=$((ka_i + 1))
  done
  return 1
}

spawn_mime() {
  if [ "$mime_count" -ge "$MIME_CAP" ]; then return 1; fi
  rand 4
  sm_t=$((rv + 1))
  sm_tries=0
  sm_placed=0
  while [ "$sm_tries" -lt 60 ] && [ "$sm_placed" -eq 0 ]; do
    rand 14
    sm_ax=$((rv + 1))
    rand 14
    sm_az=$((rv + 1))
    get_cell $sm_ax 1 $sm_az
    if [ "$gv" -eq "$AIR" ]; then
      sm_ddx=$((sm_ax - px))
      sm_ddz=$((sm_az - pz))
      abs $sm_ddx
      sm_adx=$av
      abs $sm_ddz
      sm_adz=$av
      if [ "$sm_adx" -ge 6 ]; then sm_placed=1; fi
      if [ "$sm_adz" -ge 6 ]; then sm_placed=1; fi
    fi
    sm_tries=$((sm_tries + 1))
  done
  if [ "$sm_placed" -eq 1 ]; then
    mx[$mime_count]=$sm_ax
    mz[$mime_count]=$sm_az
    my[$mime_count]=0
    mtype[$mime_count]=$sm_t
    mhp[$mime_count]=1
    mime_count=$((mime_count + 1))
    hud_static_dirty=1
  fi
  return 0
}

can_step() { cs_a=$1; cs_b=$2; cs=0
  if [ "$cs_a" -lt 1 ]; then return 0; fi
  if [ "$cs_a" -ge "$BOUND_X" ]; then return 0; fi
  if [ "$cs_b" -lt 1 ]; then return 0; fi
  if [ "$cs_b" -ge "$BOUND_Z" ]; then return 0; fi
  get_cell $cs_a 1 $cs_b
  if [ "$gv" -ne "$AIR" ]; then return 0; fi
  cs_j=0
  cs=1
  while [ "$cs_j" -lt "$mime_count" ]; do
    cs_jx=${mx[$cs_j]}
    cs_jz=${mz[$cs_j]}
    if [ "$cs_jx" -eq "$cs_a" ] && [ "$cs_jz" -eq "$cs_b" ]; then cs=0; fi
    cs_j=$((cs_j + 1))
  done
  return 0
}

update_mimes() {
  um_i=0
  while [ "$um_i" -lt "$mime_count" ]; do
    um_a=${mx[$um_i]}
    um_b=${mz[$um_i]}
    um_t=${mtype[$um_i]}
    um_ddx=$((px - um_a))
    um_ddz=$((pz - um_b))
    abs $um_ddx
    um_adx=$av
    abs $um_ddz
    um_adz=$av
    if [ "$um_ddx" -gt 0 ]; then um_sxp=1; else um_sxp=-1; fi
    if [ "$um_ddz" -gt 0 ]; then um_szp=1; else um_szp=-1; fi
    # candidates in priority order: dominant axis, other axis,
    # reverse dominant, reverse other (backtrack out of dead ends)
    if [ "$um_adx" -ge "$um_adz" ]; then
      um_p1x=$((um_a + um_sxp)); um_p1z=$um_b
      um_p2x=$um_a; um_p2z=$((um_b + um_szp))
    else
      um_p1x=$um_a; um_p1z=$((um_b + um_szp))
      um_p2x=$((um_a + um_sxp)); um_p2z=$um_b
    fi
    um_p3x=$((um_a - um_sxp)); um_p3z=$um_b
    um_p4x=$um_a; um_p4z=$((um_b - um_szp))
    um_moved=0
    um_n=1
    while [ "$um_n" -le 4 ] && [ "$um_moved" -eq 0 ]; do
      if [ "$um_n" -eq 1 ]; then um_cx=$um_p1x; um_cz=$um_p1z; fi
      if [ "$um_n" -eq 2 ]; then um_cx=$um_p2x; um_cz=$um_p2z; fi
      if [ "$um_n" -eq 3 ]; then um_cx=$um_p3x; um_cz=$um_p3z; fi
      if [ "$um_n" -eq 4 ]; then um_cx=$um_p4x; um_cz=$um_p4z; fi
      if [ "$um_cx" -eq "$px" ] && [ "$um_cz" -eq "$pz" ]; then
        um_dmg=${MIME_DMG[$um_t]}
        hurt $um_dmg
        kill_mime_at $um_a $um_b
        um_moved=1
      else
        can_step $um_cx $um_cz
        if [ "$cs" -eq 1 ]; then
          mx[$um_i]=$um_cx
          mz[$um_i]=$um_cz
          um_moved=1
        fi
      fi
      um_n=$((um_n + 1))
    done
    um_i=$((um_i + 1))
  done
}

# ─── Player ──────────────────────────────────────────────────────────
hurt() { hu_d=$1; hp=$((hp - hu_d)); digits_dirty=1; play "C3 0.15"; if [ "$hp" -lt 0 ]; then hp=0; fi; }

try_move() { tm_a=$1; tm_b=$2
  tm_nx=$((px + tm_a))
  tm_nz=$((pz + tm_b))
  if [ "$tm_nx" -lt 1 ]; then return 1; fi
  if [ "$tm_nx" -ge "$BOUND_X" ]; then return 1; fi
  if [ "$tm_nz" -lt 1 ]; then return 1; fi
  if [ "$tm_nz" -ge "$BOUND_Z" ]; then return 1; fi
  get_cell $tm_nx 1 $tm_nz
  if [ "$gv" -eq "$AIR" ]; then
    mime_at $tm_nx $tm_nz
    if [ "$mf" -eq 0 ]; then
      px=$tm_nx
      pz=$tm_nz
      return 0
    fi
  fi
  return 1
}

# ─── action animation: each move/turn glides the camera over ~0.5s ──
# Discrete state (px/pz/yaw) updates when the glide ENDS; render_frame
# reads the interpolated display values (dpx/dpz/dyaw + fractional milli
# positions) so the view eases instead of snapping.
start_anim() { ax0=$1; az0=$2; ay0=$3; ax1=$4; az1=$5; ay1=$6
  anim_ms=$ANIM_MS
  # shortest yaw arc across the 0↔3 seam (3→0 turns +90°, not -270°)
  anim_ayd=$((ay1 - ay0))
  if [ "$anim_ayd" -gt 2 ]; then anim_ayd=$((anim_ayd - 4)); fi
  if [ "$anim_ayd" -lt -2 ]; then anim_ayd=$((anim_ayd + 4)); fi
  anim_t0=$(cat /dev/time)
  anim=1
}

try_anim_move() { ta_dx=$1; ta_dz=$2
  ta_nx=$((px + ta_dx))
  ta_nz=$((pz + ta_dz))
  if [ "$ta_nx" -lt 1 ]; then return 1; fi
  if [ "$ta_nx" -ge "$BOUND_X" ]; then return 1; fi
  if [ "$ta_nz" -lt 1 ]; then return 1; fi
  if [ "$ta_nz" -ge "$BOUND_Z" ]; then return 1; fi
  get_cell $ta_nx 1 $ta_nz
  if [ "$gv" -eq "$AIR" ]; then
    start_anim $px $pz $yaw $ta_nx $ta_nz $yaw
    # a mined passage is the same 1-tall opening as a corridor (mining
    # breaks the y=1 wall), so every move is upright
    anim_ms=$ANIM_MS
    return 0
  fi
  return 1
}

start_turn() { tt=$1
  ty=$(((yaw + tt) % 4))
  start_anim $px $pz $yaw $px $pz $ty
}

# the display state the renderer uses: fractional camera position/yaw
# (milli) plus the nearest cell + yaw for the discrete culling. The
# glide is TIME-based (ANIM_MS of wall time) so every action takes the
# same 0.2s regardless of the actual render rate.
compute_display() {
  if [ "$anim" -eq 1 ]; then
    anim_el=$((anim_now - anim_t0))
    if [ "$anim_el" -gt "$anim_ms" ]; then anim_el=$anim_ms; fi
    dpcx_ms=$((ax0 * 1000 + (ax1 - ax0) * 1000 * anim_el / anim_ms))
    dpcz_ms=$((az0 * 1000 + (az1 - az0) * 1000 * anim_el / anim_ms))
    dpyw_raw_ms=$((ay0 * 90000 + anim_ayd * 90000 * anim_el / anim_ms))
    dpyw_ms=$dpyw_raw_ms
    # keep the shader yaw in 0..360000: a left turn's 0→-90° arc
    # becomes a 360→270° glide (identical rotation, positive input)
    if [ "$dpyw_ms" -lt 0 ]; then dpyw_ms=$((dpyw_ms + 360000)); fi
  else
    dpcx_ms=$((px * 1000))
    dpcz_ms=$((pz * 1000))
    dpyw_raw_ms=$((yaw * 90000))
    dpyw_ms=$dpyw_raw_ms
  fi
  dpx=$(((dpcx_ms + 500) / 1000))
  dpz=$(((dpcz_ms + 500) / 1000))
  dyaw=$((((dpyw_ms + 45000) / 90000) % 4))
}

# the eye ducks (and the walk slows) when the ceiling overhead is low:
# mining breaks only the y=0 block, so a mined passage keeps the y=1
# block and its 1-tall opening — the camera drops below it so it stops
# looking like you're walking INTO the ceiling. Keyed off the DISPLAY
# cell (where the eye actually is), so the duck happens as the eye
# crosses into the low cell.
update_crouch() {
  get_cell $dpx 1 $dpz
  if [ "$gv" -eq "$AIR" ]; then
    crouched=0
  else
    crouched=1
  fi
}

# shoot straight ahead at eye level — a 1-D walk down the facing row
shoot() {
  muzzle=5
  sh_dx=${DIR_X[$yaw]}
  sh_dz=${DIR_Z[$yaw]}
  sh_i=1
  while [ "$sh_i" -le "$RANGE" ]; do
    sh_tx=$((px + sh_dx * sh_i))
    sh_tz=$((pz + sh_dz * sh_i))
    # the border ring (0 and MAP_W-1) is solid obsidian and MUST be
    # reachable so hitting it plays the thud — bound by the full map
    if [ "$sh_tx" -lt 0 ]; then return 1; fi
    if [ "$sh_tx" -ge "$MAP_W" ]; then return 1; fi
    if [ "$sh_tz" -lt 0 ]; then return 1; fi
    if [ "$sh_tz" -ge "$MAP_D" ]; then return 1; fi
    get_cell $sh_tx 1 $sh_tz
    if [ "$gv" -ne "$AIR" ]; then
      damage_cell $sh_tx $sh_tz $gv
      return 0
    fi
    mime_at $sh_tx $sh_tz
    if [ "$mf" -eq 1 ]; then
      kill_mime_at $sh_tx $sh_tz
      return 0
    fi
    sh_i=$((sh_i + 1))
  done
  return 1
}

damage_cell() { dc_a=$1; dc_b=$2; dc_t=$3
  # indestructible blocks (obsidian — the maze border): a dull thud, no
  # damage accumulates, never breaks
  if [ "$dc_t" -eq "$OBSIDIAN" ]; then
    play "G2 0.10"
    return 0
  fi
  hardness $dc_t
  add_bhp $dc_a 1 $dc_b
  get_bhp $dc_a 1 $dc_b
  if [ "$bh" -ge "$h" ]; then
    if [ "$dc_t" -eq "$TREASURE" ]; then
      set_cell $dc_a 1 $dc_b $AIR
      claim_treasure $dc_a $dc_b
    else
      set_cell $dc_a 1 $dc_b $AIR
      score_block $dc_t
    fi
    # the radar's static cells changed — rebuild the base layer once
    hud_static_dirty=1
    play "E3 0.06"
  else
    play "C3 0.05"
  fi
}

score_block() { sb_t=$1
  if [ "$sb_t" -eq "$GOLD" ]; then score=$((score + 10)); digits_dirty=1; echo "  mined GOLD  +10"; fi
  if [ "$sb_t" -eq "$DIAMOND" ]; then score=$((score + 25)); digits_dirty=1; echo "  mined DIAMOND  +25"; fi
  if [ "$sb_t" -eq "$RUBY" ]; then score=$((score + 50)); digits_dirty=1; echo "  mined RUBY  +50"; fi
}

claim_treasure() { ct_a=$1; ct_b=$2; ct_t=0
  while [ "$ct_t" -lt "$TREASURE_TOTAL" ]; do
    ct_txv=${tpx[$ct_t]}
    ct_tzv=${tpz[$ct_t]}
    if [ "$ct_txv" -eq "$ct_a" ] && [ "$ct_tzv" -eq "$ct_b" ]; then
      ct_fv=${found[$ct_t]}
      if [ "$ct_fv" -eq 0 ]; then
        found[$ct_t]=1
        found_count=$((found_count + 1))
        score=$((score + 100))
        maxhp=$((maxhp + 1))
        hp=$((hp + 1))
        digits_dirty=1
        echo ""
        echo "=============================================="
        echo "  TREASURE FOUND: ${TREASURES[$ct_t]}"
        echo "  +100 score   +1 max HP"
        echo "  artifacts recovered: $found_count / $TREASURE_TOTAL"
        echo "  (the MIMEs can smell it — two more spawn)"
        echo "=============================================="
        play "C5 0.10"
        play "E5 0.10"
        play "G5 0.15"
        spawn_mime
        spawn_mime
      fi
      return 0
    fi
    ct_t=$((ct_t + 1))
  done
  return 1
}

# ─── World generation ────────────────────────────────────────────────
gen_maze() {
  # fill the whole maze with 2-tall stone walls
  gm_x=0
  while [ "$gm_x" -lt "$MAP_W" ]; do
    gm_z=0
    while [ "$gm_z" -lt "$MAP_D" ]; do
      set_cell $gm_x 0 $gm_z $DIRT
      set_cell $gm_x 1 $gm_z $STONE
      gm_z=$((gm_z + 1))
    done
    gm_x=$((gm_x + 1))
  done
  # clear the starting corner first (player spawns at 2,2) — the
  # drunkard walk below STARTS here, so the pocket stays connected
  gm_sx=1
  while [ "$gm_sx" -le 3 ]; do
    gm_sz=1
    while [ "$gm_sz" -le 3 ]; do
      set_cell $gm_sx 1 $gm_sz $AIR
      gm_sz=$((gm_sz + 1))
    done
    gm_sx=$((gm_sx + 1))
  done
  # drunkard's walk carves the floor (and the air above it), starting
  # from the spawn cell so the maze is always reachable
  gm_cx=2
  gm_cz=2
  gm_steps=0
  gm_total=$((MAP_W * MAP_D * 55 / 100))
  while [ "$gm_steps" -lt "$gm_total" ]; do
    set_cell $gm_cx 1 $gm_cz $AIR
    rand 4
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
  # sprinkle coloured blocks into the y1 walls (the mineable layer)
  gm_placed=0
  while [ "$gm_placed" -lt 18 ]; do
    rand 14
    gm_rx=$((rv + 1))
    rand 14
    gm_rz=$((rv + 1))
    get_cell $gm_rx 1 $gm_rz
    if [ "$gv" -eq "$STONE" ]; then
      rand 3
      if [ "$rv" -eq 0 ]; then set_cell $gm_rx 1 $gm_rz $GOLD; fi
      if [ "$rv" -eq 1 ]; then set_cell $gm_rx 1 $gm_rz $DIAMOND; fi
      if [ "$rv" -eq 2 ]; then set_cell $gm_rx 1 $gm_rz $RUBY; fi
      gm_placed=$((gm_placed + 1))
    fi
  done
  # floating gems at y=2 for depth
  gm_placed=0
  while [ "$gm_placed" -lt 12 ]; do
    rand 14
    gm_rx=$((rv + 1))
    rand 14
    gm_rz=$((rv + 1))
    get_cell $gm_rx 2 $gm_rz
    if [ "$gv" -eq "$AIR" ]; then
      rand 3
      if [ "$rv" -eq 0 ]; then set_cell $gm_rx 2 $gm_rz $DIAMOND; fi
      if [ "$rv" -eq 1 ]; then set_cell $gm_rx 2 $gm_rz $RUBY; fi
      if [ "$rv" -eq 2 ]; then set_cell $gm_rx 2 $gm_rz $GOLD; fi
      gm_placed=$((gm_placed + 1))
    fi
  done
  # the maze border is INDESTRUCTIBLE obsidian — a solid perimeter the
  # player can never mine through. Lay the ring LAST so it overwrites
  # any border cells the drunkard's walk carved. Bounds go through
  # PLAIN vars: a `$((…))` inside a multi-test `||` chain (and a `\`
  # line continuation) is not parsed reliably — it silently dropped the
  # z-tests, leaving only the x=0/z=0 edges obsidian.
  gm_bx=$((MAP_W - 1))
  gm_bz=$((MAP_D - 1))
  gm_x=0
  while [ "$gm_x" -lt "$MAP_W" ]; do
    gm_z=0
    while [ "$gm_z" -lt "$MAP_D" ]; do
      if [ "$gm_x" -eq 0 ] || [ "$gm_x" -eq "$gm_bx" ] || [ "$gm_z" -eq 0 ] || [ "$gm_z" -eq "$gm_bz" ]; then
        set_cell $gm_x 0 $gm_z $OBSIDIAN
        set_cell $gm_x 1 $gm_z $OBSIDIAN
      fi
      gm_z=$((gm_z + 1))
    done
    gm_x=$((gm_x + 1))
  done
  # a walkable 2-tall corridor rings the maze just inside the obsidian
  # border, so every edge is reachable and the indestructible thud can
  # be heard from any side (the drunkard's walk alone rarely carves the
  # far side). Interior walls at x/z ∈ [2, 13] are untouched.
  gm_ci=$((MAP_W - 2))
  gm_x=1
  while [ "$gm_x" -le "$gm_ci" ]; do
    set_cell $gm_x 1 1 $AIR
    set_cell $gm_x 1 $gm_ci $AIR
    set_cell 1 1 $gm_x $AIR
    set_cell $gm_ci 1 $gm_x $AIR
    gm_x=$((gm_x + 1))
  done
}

# treasure positions — the index arrives as an ARG so the array-write
# strings read it from the runtime store (a loop var like `pt_t` can be
# hoisted into a JS let the store can't see)
set_treasure_pos() { ti=$1; tx=$2; tz=$3
  tpx[$ti]=$tx
  tpz[$ti]=$tz
}

place_treasures() {
  pt_t=0
  while [ "$pt_t" -lt "$TREASURE_TOTAL" ]; do
    pt_tries=0
    pt_placed=0
    while [ "$pt_tries" -lt 100 ] && [ "$pt_placed" -eq 0 ]; do
      rand 14
      pt_rx=$((rv + 1))
      rand 14
      pt_rz=$((rv + 1))
      get_cell $pt_rx 1 $pt_rz
      if [ "$gv" -eq "$AIR" ]; then
        pt_ddx=$((pt_rx - px))
        pt_ddz=$((pt_rz - pz))
        abs $pt_ddx
        pt_adx=$av
        abs $pt_ddz
        pt_adz=$av
        if [ "$pt_adx" -ge 3 ]; then pt_placed=1; fi
        if [ "$pt_adz" -ge 3 ]; then pt_placed=1; fi
      fi
      pt_tries=$((pt_tries + 1))
    done
    if [ "$pt_placed" -eq 1 ]; then
      set_cell $pt_rx 1 $pt_rz $TREASURE
      set_treasure_pos $pt_t $pt_rx $pt_rz
    fi
    pt_t=$((pt_t + 1))
  done
}

# ─── Rendering ───────────────────────────────────────────────────────
# BOTH shader stages are AUTHORED IN BASH — see
# examples/mimecroft-frag.sh (fragment) and examples/mimecroft-vertex.sh
# (vertex) — and compiled by the sh→GLSL generator (sh2glsl /
# glsl_backend.rs) at startup.
#
# The vertex shader is authored in bash (emit_vertex_shader compiles
# /examples/mimecroft-vertex.sh with `sh2glsl --vertex`); the FRAGMENT
# shader is authored in bash (emit_fragment_shader writes the program to
# /tmp and compiles it with `sh2glsl`). Both fall back to the
# equivalent hand-written GLSL when the generator is unavailable or its
# output fails to compile under the browser's ANGLE.
emit_vertex_shader() {
  # the hand-written equivalent (the fallback when the generator is
  # unavailable OR its GLSL fails to compile under the browser's ANGLE —
  # the CLI NullGL never type-checks the shader, so a real compile is
  # the ground truth). Same look as the generated shader: object→world,
  # camera-relative delta (the eye at the player cell CENTRE — only
  # the y gets +0.5; x/z stay unshifted so corridors render centred),
  # yaw rotation, the fake perspective + the
  # strafe screen-shift (uCamShift·w keeps it a constant NDC-x offset),
  # and the uOverlay > 0.5 flat-quad path.
  vs_fb="attribute vec3 aPosition; attribute vec3 aShade; attribute vec2 aUv; uniform vec3 uCamPos; uniform float uCamYaw; uniform float uCamShift; uniform vec3 uObjPos; uniform vec3 uBlockColor; uniform vec3 uScale; uniform float uOverlay; varying vec4 vColor; varying vec2 vUv; void main() { vec3 p = aPosition * uScale + uObjPos; if (uOverlay > 0.5) { gl_Position = vec4(p.x + uCamShift, p.y, -0.95, 1.0); vColor = vec4(aShade * uBlockColor, 1.0); vUv = vec2(0.0); return; } vec3 cam = uCamPos + vec3(0.0, 0.5, 0.0); vec3 d = p - cam; float a = uCamYaw * 0.0174532925; float c = cos(a); float s = sin(a); vec3 rel = vec3(d.x * c + d.z * s, d.y, -d.x * s + d.z * c); float w = -rel.z; gl_Position = vec4(rel.x * 0.45 + uCamShift * w, rel.y * 0.45, w * w / 64.0, w); vColor = vec4(aShade * uBlockColor, 1.0); vUv = aUv; }"
  # compile the bash-authored vertex program — canonical at
  # /examples/mimecroft-vertex.sh (the /examples mount serves
  # www/examples/) — with sh2glsl --vertex; fall back when the
  # generator is unavailable or the file isn't mounted
  glsl=$(sh2glsl --vertex /examples/mimecroft-vertex.sh)
  if [ "$glsl" != "" ]; then
    echo "$glsl" > /dev/webgl/shader/vertex
    # real-GL ground truth: if the generated shader failed to compile,
    # fall back to the hand-written one (same look, guaranteed-ES1.00).
    # The device logs "[shader/vertex] FAILED: …" on a bad compile.
    vs_log=$(cat /dev/webgl/log)
    vs_probe=${vs_log%FAILED*}
    if [ "$vs_probe" != "$vs_log" ]; then
      echo "$vs_fb" > /dev/webgl/shader/vertex
    fi
  else
    echo "$vs_fb" > /dev/webgl/shader/vertex
  fi
}

# the fragment shader is authored in bash (see examples/mimecroft-frag.sh)
# and compiled by the sh→GLSL generator (sh2glsl / glsl_backend.rs) at
# startup.
emit_fragment_shader() {
  # write the bash-authored fragment program to /tmp (single-quoted so
  # $(( ... )) stays literal), then compile it with the generator
  echo 'fx=$((frag_x))' > /tmp/mimecroft-frag.sh
  echo 'fy=$((frag_y))' >> /tmp/mimecroft-frag.sh
  echo 'r=$((vcolor_r))' >> /tmp/mimecroft-frag.sh
  echo 'g=$((vcolor_g))' >> /tmp/mimecroft-frag.sh
  echo 'b=$((vcolor_b))' >> /tmp/mimecroft-frag.sh
  # the block texture sampled per pixel (bridged by the generator)
  echo 'r=$((r * tex_r / 255))' >> /tmp/mimecroft-frag.sh
  echo 'g=$((g * tex_g / 255))' >> /tmp/mimecroft-frag.sh
  echo 'b=$((b * tex_b / 255))' >> /tmp/mimecroft-frag.sh
  # crack overlay: the transparent crack texture (cr_r/g/b/a bridges),
  # mixed in by the damage level (uDamage bridge) — layered over ANY
  # block texture so damaged blocks show cracks
  echo 'if [ "$damage" -gt 0 ]; then' >> /tmp/mimecroft-frag.sh
  echo '  mix=$((damage * cr_a / 3))' >> /tmp/mimecroft-frag.sh
  echo '  r=$((r * (255 - mix) / 255 + cr_r * mix / 255))' >> /tmp/mimecroft-frag.sh
  echo '  g=$((g * (255 - mix) / 255 + cr_g * mix / 255))' >> /tmp/mimecroft-frag.sh
  echo '  b=$((b * (255 - mix) / 255 + cr_b * mix / 255))' >> /tmp/mimecroft-frag.sh
  echo 'fi' >> /tmp/mimecroft-frag.sh
  if [ "$CRT_ON" -eq 1 ]; then
    echo 'scan=$((fy % 6))' >> /tmp/mimecroft-frag.sh
    echo 'if [ "$scan" -eq 0 ]; then' >> /tmp/mimecroft-frag.sh
    echo '  r=$((r * 90 / 100))' >> /tmp/mimecroft-frag.sh
    echo '  g=$((g * 90 / 100))' >> /tmp/mimecroft-frag.sh
    echo '  b=$((b * 90 / 100))' >> /tmp/mimecroft-frag.sh
    echo 'fi' >> /tmp/mimecroft-frag.sh
  fi
  if [ "$CORRUPT_ON" -eq 1 ]; then
    echo 'hash=$((fx * 7 + fy * 13))' >> /tmp/mimecroft-frag.sh
    echo 'corrupt=$((hash % 97))' >> /tmp/mimecroft-frag.sh
    echo 'if [ "$corrupt" -eq 0 ]; then' >> /tmp/mimecroft-frag.sh
    echo '  r=255' >> /tmp/mimecroft-frag.sh
    echo '  g=$((g / 2))' >> /tmp/mimecroft-frag.sh
    echo '  b=$((b / 2))' >> /tmp/mimecroft-frag.sh
    echo 'fi' >> /tmp/mimecroft-frag.sh
  fi
  if [ "$CRT_ON" -eq 1 ]; then
    echo 'vx=$((fx - 400))' >> /tmp/mimecroft-frag.sh
    echo 'vy=$((fy - 300))' >> /tmp/mimecroft-frag.sh
    echo 'if [ "$vx" -lt 0 ]; then vx=$((0 - vx)); fi' >> /tmp/mimecroft-frag.sh
    echo 'if [ "$vy" -lt 0 ]; then vy=$((0 - vy)); fi' >> /tmp/mimecroft-frag.sh
    echo 'edge=$((vx + vy))' >> /tmp/mimecroft-frag.sh
    echo 'if [ "$edge" -gt 450 ]; then' >> /tmp/mimecroft-frag.sh
    echo '  dim=$((edge - 450))' >> /tmp/mimecroft-frag.sh
    echo '  if [ "$dim" -gt 30 ]; then dim=30; fi' >> /tmp/mimecroft-frag.sh
    # multiplicative dim (r - r·dim/255): scales toward dark instead of
    # subtracting — dark pixels can never hard-clip to black. r·dim ≤
    # 255·30 fits mediump int, so the fragment stays ES 1.00 portable.
    echo '  r=$((r - r * dim / 255))' >> /tmp/mimecroft-frag.sh
    echo '  g=$((g - g * dim / 255))' >> /tmp/mimecroft-frag.sh
    echo '  b=$((b - b * dim / 255))' >> /tmp/mimecroft-frag.sh
    echo 'fi' >> /tmp/mimecroft-frag.sh
  fi
  echo 'if [ "$r" -lt 0 ]; then r=0; fi' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$g" -lt 0 ]; then g=0; fi' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$b" -lt 0 ]; then b=0; fi' >> /tmp/mimecroft-frag.sh
  echo 'putb $r' >> /tmp/mimecroft-frag.sh
  echo 'putb $g' >> /tmp/mimecroft-frag.sh
  echo 'putb $b' >> /tmp/mimecroft-frag.sh
  echo 'putb 255' >> /tmp/mimecroft-frag.sh
  # compile it with the sh→GLSL generator; fall back to the equivalent
  # embedded shader when the generator isn't installed
  # the hand-written equivalent (the fallback when the generator is
  # unavailable OR its GLSL fails to compile under the browser's ANGLE —
  # the CLI NullGL never type-checks the shader, so a real compile is
  # the ground truth). Assembled from parts so the CRT/corruption
  # effects can be disabled with CRT_ON/CORRUPT_ON (same look as the
  # generated shader: texture × colour tint + the optional effects).
  fs_fb="precision mediump float; varying highp vec4 vColor; varying highp vec2 vUv; uniform sampler2D uTex; uniform sampler2D uCrack; uniform highp float uOverlay; uniform int uDamage; void main() { if (uOverlay > 0.5) { gl_FragColor = vec4(vColor.rgb, 1.0); return; } vec3 c = texture2D(uTex, vUv).rgb * vColor.rgb; if (uDamage > 0) { vec4 cr = texture2D(uCrack, vUv); float s = float(uDamage) / 3.0; c = mix(c, cr.rgb, cr.a * s); }"
  if [ "$CRT_ON" -eq 1 ]; then
    fs_fb="$fs_fb if (mod(gl_FragCoord.y, 6.0) < 1.0) { c *= 0.9; }"
  fi
  if [ "$CORRUPT_ON" -eq 1 ]; then
    fs_fb="$fs_fb float h = mod(floor(gl_FragCoord.x) * 7.0 + floor(gl_FragCoord.y) * 13.0, 97.0); if (h < 1.0) { c = vec3(1.0, c.g * 0.5, c.b * 0.5); }"
  fi
  if [ "$CRT_ON" -eq 1 ]; then
    fs_fb="$fs_fb float e = abs(gl_FragCoord.x - 400.0) + abs(gl_FragCoord.y - 300.0); if (e > 450.0) { float d = min(e - 450.0, 30.0); c *= (255.0 - d) / 255.0; }"
  fi
  fs_fb="$fs_fb gl_FragColor = vec4(c, 1.0); }"
  # the sh→GLSL generator hardcodes the 16×16 texel grid (uv_x = vUv*16);
  # it is only valid at the default resolution. For other texture sizes
  # use the hand-written shader — it samples raw UVs and the device's
  # NEAREST filter does the texel pick at any resolution.
  if [ "$tex_size" -eq 16 ]; then
    glsl=$(sh2glsl /tmp/mimecroft-frag.sh)
    if [ "$glsl" != "" ]; then
      echo "$glsl" > /dev/webgl/shader/fragment
      # real-GL ground truth: if the generated shader failed to compile,
      # fall back to the hand-written one (same look, guaranteed-ES1.00).
      # The device logs "[shader/fragment] FAILED: …" on a bad compile.
      fs_log=$(cat /dev/webgl/log)
      fs_probe=${fs_log%FAILED*}
      if [ "$fs_probe" != "$fs_log" ]; then
        echo "$fs_fb" > /dev/webgl/shader/fragment
      fi
    else
      echo "$fs_fb" > /dev/webgl/shader/fragment
    fi
  else
    echo "$fs_fb" > /dev/webgl/shader/fragment
  fi
}

setup_webgl() {
  # the vertex shader is authored in bash — emit_vertex_shader compiles
  # /examples/mimecroft-vertex.sh via sh2glsl --vertex when available,
  # otherwise the equivalent hand-written GLSL (same look: yaw rotation,
  # fake perspective, the strafe screen-shift, the overlay flat-quad
  # path)
  emit_vertex_shader
  # the fragment shader is authored in bash (emit_fragment_shader) and
  # compiled by sh2glsl when available — otherwise the equivalent
  # hand-written textured GLSL (the same texture × colour tint + the
  # CRT/corruption/vignette effects; uOverlay > 0.5 keeps the HUD flat)
  emit_fragment_shader
  echo "link" > /dev/webgl/program
  echo "f32 -0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 -0.5 0.5 -0.5 -0.5 -0.5 0.5 0.5 -0.5 0.5 0.5 -0.5 -0.5 -0.5 -0.5 -0.5 -0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 -0.5 -0.5 0.5 -0.5 -0.5 0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 -0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 -0.5 -0.5 0.5 -0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 -0.5 -0.5" > /dev/webgl/buffer/aPosition
  echo "f32 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 0.9 1 1 1 1 1 1 1 1 1 1 1 1 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.95 0.95 0.95 0.95 0.95 0.95 0.95 0.95 0.95 0.95 0.95 0.95 0.85 0.85 0.85 0.85 0.85 0.85 0.85 0.85 0.85 0.85 0.85 0.85" > /dev/webgl/buffer/aShade
  echo "f32 0 0 1 0 1 1 0 1 0 0 1 0 1 1 0 1 0 0 1 0 1 1 0 1 0 0 1 0 1 1 0 1 0 0 1 0 1 1 0 1 0 0 1 0 1 1 0 1" > /dev/webgl/buffer/aUv
  echo "0" > /dev/webgl/uniform/1i/uTex
  echo "9" > /dev/webgl/uniform/1i/uCrack
  echo "0" > /dev/webgl/uniform/1i/uDamage
  fmt_pos $cam_shift_ms
  echo "$fv" > /dev/webgl/uniform/1f/uCamShift
  echo "u16 0 1 2 0 2 3 4 5 6 4 6 7 8 9 10 8 10 11 12 13 14 12 14 15 16 17 18 16 18 19 20 21 22 20 22 23" > /dev/webgl/buffer/cube
  echo "f32 -0.5 -0.5 0 0.5 -0.5 0 0.5 0.5 0 -0.5 0.5 0" > /dev/webgl/buffer/quadpos
  echo "f32 1 1 1 1 1 1 1 1 1 1 1 1" > /dev/webgl/buffer/quadshade
  echo "u16 0 1 2 0 2 3" > /dev/webgl/buffer/quadi
  echo "0.05 0.05 0.12 1.0" > /dev/webgl/clearcolor
}

# ─── texture loading: run examples/textures/texture-<name>.sh --tsv,
# parse the tab-separated R G B fields and upload to /dev/webgl/texture/<idx>.
# The transpiled shell's ${s#*TAB} prefix-strip is greedy and IFS-splitting
# is broken, so fields are consumed with the probe loop from read-texture.sh.
strip_tex_field() { sf_done=0
  while [ "$sf_done" -eq 0 ]; do
    sf_probe=${lt_s%%	*}
    if [ "$sf_probe" = "" ]; then sf_done=1; lt_s=${lt_s#?}; else lt_s=${lt_s#?}; fi
  done
}

read_tex_field() { f=${lt_s%%	*}
  strip_tex_field
}

# texture colour 0..255 → NDC string "0.xx" for the loading preview
fmt_c() { fc_v=$1
  fc_x=$(( (fc_v * 100) / 255 ))
  if [ "$fc_x" -ge 100 ]; then fv="1.00"
  elif [ "$fc_x" -lt 10 ]; then fv="0.0$fc_x"
  else fv="0.$fc_x"; fi
}

load_tex() { lt_name=$1; lt_idx=$2
  # a macrotask yield so the preceding "    name…" line paints before
  # this texture's (transpiled) generation runs
  sleep 0.01
  # cached payload from an earlier run (session /tmp, persistent /home);
  # the cache key carries the resolution + seed so a settings change
  # regenerates instead of reusing a stale texture
  if [ -f /home/mimecroft-tex-$lt_name-$tex_size-$tex_seed ]; then
    cat /home/mimecroft-tex-$lt_name-$tex_size-$tex_seed > /dev/webgl/texture/$lt_idx
    return 0
  fi
  if [ -f /tmp/mimecroft-tex-$lt_name-$tex_size-$tex_seed ]; then
    cat /tmp/mimecroft-tex-$lt_name-$tex_size-$tex_seed > /dev/webgl/texture/$lt_idx
    return 0
  fi
  lt_s=$(bash /examples/textures/texture-$lt_name.sh --tsv --size $tex_size --seed $tex_seed)
  lt_hdr=${lt_s%%	*}
  if [ "$lt_hdr" != "#texture" ]; then return 0; fi
  # header: strip #texture + NAME, READ SIZExSIZE, strip the rest
  strip_tex_field
  strip_tex_field
  lt_sz=${lt_s%%	*}
  lt_size=${lt_sz%%x*}
  strip_tex_field
  strip_tex_field
  strip_tex_field
  lt_s=${lt_s#?}
  # loading-screen geometry: 4×2 grid of 180-milli previews, 16×16 cells
  lt_basex=$(( 140 + (lt_idx - 1) % 4 * 470 ))
  lt_basey=$(( 1600 - (lt_idx - 1) / 4 * 470 ))
  lt_cell=$(( 180 / lt_size ))
  lt_payload="$lt_size"
  lt_preview=""
  lt_px=0
  lt_pxmax=$((lt_size * lt_size))
  while [ "$lt_px" -lt "$lt_pxmax" ]; do
    read_tex_field
    lt_r=$f
    read_tex_field
    lt_g=$f
    read_tex_field
    lt_b=$f
    lt_payload="$lt_payload $lt_r $lt_g $lt_b"
    # one preview rect per pixel — the texture appears as it generates
    lt_col=$(( lt_px % lt_size ))
    lt_row=$(( lt_px / lt_size ))
    lt_pxm=$(( lt_basex + lt_col * lt_cell ))
    lt_pym=$(( lt_basey - lt_row * lt_cell ))
    fmt_ndc $lt_pxm
    lt_cxs=$fv
    fmt_ndc $lt_pym
    lt_cys=$fv
    fmt_ndc $(( lt_cell + 1 ))
    lt_ws=$fv
    fmt_c $lt_r
    lt_cr=$fv
    fmt_c $lt_g
    lt_cg=$fv
    fmt_c $lt_b
    lt_cb=$fv
    lt_preview="$lt_preview$lt_cxs $lt_cys $lt_ws $lt_ws $lt_cr $lt_cg $lt_cb
"
    lt_px=$((lt_px + 1))
  done
  echo "$lt_payload" > /home/mimecroft-tex-$lt_name-$tex_size-$tex_seed
  echo "$lt_payload" > /tmp/mimecroft-tex-$lt_name-$tex_size-$tex_seed
  echo "$lt_payload" > /dev/webgl/texture/$lt_idx
  # show the freshly generated texture on the loading screen (one swap
  # keeps the keyboard grab fresh, so keys typed during startup queue)
  echo "$lt_preview" > /dev/webgl/hud
  echo "swap" > /dev/webgl/call
}

# RGBA variant (the transparent crack overlay — R G B A per pixel)
load_tex4() { lt_name=$1; lt_idx=$2
  sleep 0.01
  if [ -f /tmp/mimecroft-tex-$lt_name-$tex_size-$tex_seed ]; then
    cat /tmp/mimecroft-tex-$lt_name-$tex_size-$tex_seed > /dev/webgl/texture/$lt_idx
    return 0
  fi
  lt_s=$(bash /examples/textures/texture-$lt_name.sh --tsv --size $tex_size --seed $tex_seed)
  lt_hdr=${lt_s%%	*}
  if [ "$lt_hdr" != "#texture" ]; then return 0; fi
  strip_tex_field
  strip_tex_field
  lt_sz=${lt_s%%	*}
  lt_size=${lt_sz%%x*}
  strip_tex_field
  strip_tex_field
  strip_tex_field
  lt_s=${lt_s#?}
  lt_payload="$lt_size"
  lt_px=0
  lt_pxmax=$((lt_size * lt_size))
  while [ "$lt_px" -lt "$lt_pxmax" ]; do
    read_tex_field
    lt_r=$f
    read_tex_field
    lt_g=$f
    read_tex_field
    lt_b=$f
    read_tex_field
    lt_a=$f
    lt_payload="$lt_payload $lt_r $lt_g $lt_b $lt_a"
    lt_px=$((lt_px + 1))
  done
  echo "$lt_payload" > /tmp/mimecroft-tex-$lt_name-$tex_size-$tex_seed
  echo "$lt_payload" > /dev/webgl/texture/$lt_idx
}

load_textures() {
  # wipe the GL back buffer first so the loading grid builds on black
  # instead of accumulating over the menu card (the HUD composite blends
  # the layer over the preserved drawing buffer)
  echo "clear" > /dev/webgl/call
  echo "    stone…"
  load_tex stone 1
  echo "    sandstone…"
  load_tex sandstone 2
  echo "    water…"
  load_tex water 3
  echo "    brick…"
  load_tex brick 4
  echo "    grass…"
  load_tex grass 5
  echo "    leaves…"
  load_tex leaves 6
  echo "    wood…"
  load_tex wood 7
  echo "    dirt…"
  load_tex dirt 8
  echo "    obsidian…"
  load_tex obsidian 10
  echo "    jpeg…"
  load_tex jpeg 11
  echo "    png…"
  load_tex png 12
  echo "    octet…"
  load_tex octet 13
  echo "    text…"
  load_tex text 14
  echo "    crack…"
  load_tex4 crack 9
  # the MIME type textures — one icon per evil MIME (11=jpeg 12=png
  # 13=octet-stream 14=text/plain)
  echo "    MIME icons…"
  load_tex jpeg 11
  load_tex png 12
  load_tex octet 13
  load_tex text 14
}

# the world is drawn as ONE batched payload per frame (/dev/webgl/blocks:
# "x y z sx sy sz r g b tx dam" lines) — the per-cube echo round-trips
# were the frame's bottleneck (~6 async dispatches per cube)
draw_block() { db_a=$1; db_b=$2; db_c=$3; db_r=$4; db_g=$5; db_bl=$6; db_tx=$7
  get_bhp $db_a $db_b $db_c
  blk_p="${blk_p}$db_a $db_b $db_c 1 1 1 $db_r $db_g $db_bl $db_tx $bh
"
}

# texture index per block type (1=stone 2=sandstone 3=water 4=brick
# 5=grass; 0 = the device's white fallback → the flat block colour)
texture_of() { to_t=$1
  if [ "$to_t" -eq 2 ]; then tx=1
  elif [ "$to_t" -eq 3 ]; then tx=10
  elif [ "$to_t" -eq 4 ]; then tx=2
  elif [ "$to_t" -eq 5 ]; then tx=3
  elif [ "$to_t" -eq 6 ]; then tx=4
  elif [ "$to_t" -eq 7 ]; then tx=5
  else tx=0; fi
}

# texture per MIME type (1=jpeg 2=png 3=octet 4=text)
mime_tex_of() { mtt=$1
  if [ "$mtt" -eq 1 ]; then tx=11
  elif [ "$mtt" -eq 2 ]; then tx=12
  elif [ "$mtt" -eq 3 ]; then tx=13
  else tx=14; fi
}

# cull + draw one cell (or a mime standing in it)
try_draw() { td_a=$1; td_b=$2; td_c=$3
  get_cell $td_a $td_b $td_c
  if [ "$gv" -eq "$AIR" ]; then
    if [ "$td_b" -eq 1 ]; then
      mime_at $td_a $td_c
      if [ "$mf" -eq 1 ]; then
        mime_tex_of $mt
        blk_p="${blk_p}$td_a $td_b $td_c 0.7 0.7 0.7 1 1 1 $tx 0
"
      fi
    fi
    return 1
  fi
  td_ddx=$((td_a - dpx))
  td_ddz=$((td_c - dpz))
  abs $td_ddx
  td_adx=$av
  abs $td_ddz
  td_adz=$av
  if [ "$td_adx" -gt "$VIEW_R" ]; then return 1; fi
  if [ "$td_adz" -gt "$VIEW_R" ]; then return 1; fi
  td_infront=0
  td_inrow=0
  if [ "$dyaw" -eq 0 ]; then
    if [ "$td_c" -lt "$dpz" ]; then td_infront=1; fi
    td_fov=$((td_adz + td_adz / 2 + 1))
    if [ "$td_adx" -le "$td_fov" ]; then td_inrow=1; fi
  fi
  if [ "$dyaw" -eq 1 ]; then
    if [ "$td_a" -gt "$dpx" ]; then td_infront=1; fi
    td_fov=$((td_adx + td_adx / 2 + 1))
    if [ "$td_adz" -le "$td_fov" ]; then td_inrow=1; fi
  fi
  if [ "$dyaw" -eq 2 ]; then
    if [ "$td_c" -gt "$dpz" ]; then td_infront=1; fi
    td_fov=$((td_adz + td_adz / 2 + 1))
    if [ "$td_adx" -le "$td_fov" ]; then td_inrow=1; fi
  fi
  if [ "$dyaw" -eq 3 ]; then
    if [ "$td_a" -lt "$dpx" ]; then td_infront=1; fi
    td_fov=$((td_adx + td_adx / 2 + 1))
    if [ "$td_adz" -le "$td_fov" ]; then td_inrow=1; fi
  fi
  if [ "$td_infront" -eq 0 ]; then return 1; fi
  if [ "$td_inrow" -eq 0 ]; then return 1; fi
  block_color $gv
  texture_of $gv
  draw_block $td_a $td_b $td_c $cr $cg $cb $tx
  return 0
}

# painter's algorithm without sorting: iterate the grid so cells are
# drawn far-to-near along the facing axis (yaw 0→-z, 1→+x, 2→+z, 3→-x)
render_frame() {
  echo "clear" > /dev/webgl/call
  echo "0.0" > /dev/webgl/uniform/1f/uOverlay
  # restore the cube bindings (the overlay HUD switches them to quad)
  echo "aPosition aPosition" > /dev/webgl/bind
  echo "aShade aShade" > /dev/webgl/bind
  blk_p=""
  fmt_pos $dpcx_ms
  cxs=$fv
  fmt_pos $dpcz_ms
  czs=$fv
  fmt_pos $dpyw_ms
  yws=$fv
  # the eye height: standing 0.5 (the shader adds 0.5 to uCamPos.y);
  # crouched −0.4 → the eye ducks to 0.1 under a 1-tall opening
  if [ "$crouched" -eq 1 ]; then cy_ms=-400; else cy_ms=0; fi
  fmt_pos $cy_ms
  cys=$fv
  echo "$cxs $cys $czs" > /dev/webgl/uniform/3f/uCamPos
  echo "$yws" > /dev/webgl/uniform/1f/uCamYaw
  # floor + ceiling planes — the background. They span the whole maze
  # and cross the camera, so their clipped depths are garbage; draw
  # them FIRST with depth WRITES OFF (gl.depthMask 0) — they fill the
  # void but never occlude the cubes, which paint over them.
  bg_p="8 -0.05 8 16 0.1 16 0.45 0.40 0.34 0 0
"
  bg_p="${bg_p}8 2.05 8 16 0.1 16 0.24 0.24 0.28 0 0
"
  if [ "$dyaw" -eq 0 ]; then
    # facing -z: front = z < dpz, so FAR = smallest z — draw z
    # ascending so the far "outside" cubes hit the canvas first and
    # the near destructible walls paint over them
    rf_z=0
    while [ "$rf_z" -lt "$MAP_D" ]; do
      rf_x=0
      while [ "$rf_x" -lt "$MAP_W" ]; do
        try_draw $rf_x 2 $rf_z
        try_draw $rf_x 1 $rf_z
        try_draw $rf_x 0 $rf_z
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
        try_draw $rf_x 2 $rf_z
        try_draw $rf_x 1 $rf_z
        try_draw $rf_x 0 $rf_z
        rf_z=$((rf_z + 1))
      done
      rf_x=$((rf_x - 1))
    done
  fi
  if [ "$dyaw" -eq 2 ]; then
    # facing +z: front = z > dpz, so FAR = largest z — draw z
    # descending so far cubes hit the canvas first, near last
    rf_z=$BOUND_Z
    while [ "$rf_z" -ge 0 ]; do
      rf_x=0
      while [ "$rf_x" -lt "$MAP_W" ]; do
        try_draw $rf_x 2 $rf_z
        try_draw $rf_x 1 $rf_z
        try_draw $rf_x 0 $rf_z
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
        try_draw $rf_x 2 $rf_z
        try_draw $rf_x 1 $rf_z
        try_draw $rf_x 0 $rf_z
        rf_z=$((rf_z + 1))
      done
      rf_x=$((rf_x + 1))
    done
  fi
  # background planes first (depth writes off — they never occlude),
  # then the cubes (depth writes on, far-to-near painter's order)
  echo "0" > /dev/webgl/depthmask
  echo "$bg_p" > /dev/webgl/blocks
  echo "1" > /dev/webgl/depthmask
  echo "$blk_p" > /dev/webgl/blocks
}

# ─── HUD (the terminal is the dashboard) ────────────────────────────
# ─── Canvas HUD (drawn on the 3D view) ─────────────────────────────
# Positions are integer milli-NDC (0..2000 maps to NDC -1..1); fmt_ndc
# turns them into the decimal strings the uniforms need — pure integer
# math, no floats, no bc.
CELL_W="0.040"
CELL_H="0.056"
GLP_W="0.008"
GLP_H="0.011"

fmt_pos() { fp_ms=$1
  # negative milli values are legal (left turns glide 0 → -90°) —
  # format the magnitude and apply the sign
  fp_neg=0
  if [ "$fp_ms" -lt 0 ]; then fp_neg=1; fp_ms=$((0 - fp_ms)); fi
  fp_i=$((fp_ms / 1000))
  fp_f=$((fp_ms % 1000))
  fp_fs=$fp_f
  if [ "$fp_f" -lt 10 ]; then fp_fs="00$fp_f"; elif [ "$fp_f" -lt 100 ]; then fp_fs="0$fp_f"; fi
  if [ "$fp_neg" -eq 1 ]; then fv="-$fp_i.$fp_fs"; else fv="$fp_i.$fp_fs"; fi
}

fmt3() { fp=$1
  if [ "$fp" -lt 10 ]; then fp="00$fp"; elif [ "$fp" -lt 100 ]; then fp="0$fp"; fi
  fv=$fp
}
fmt_ndc() { fm=$1
  if [ "$fm" -eq 0 ]; then fv="-1.000"
  elif [ "$fm" -eq 2000 ]; then fv="1.000"
  elif [ "$fm" -gt 1000 ]; then
    fx=$((fm-1000))
    fmt3 $fx
    fv="0.$fv"
  else
    fx=$((1000-fm))
    fmt3 $fx
    fv="-0.$fv"
  fi
}

# 2D overlay rect — appended to the batched /dev/webgl/hud payload
# (one device write per frame instead of four per rect: the HUD used to
# cost ~90ms of async writes per frame and blink, because it was drawn
# after the swap and wiped by the next clear)
draw_rect() { dr_cx=$1; dr_cy=$2; dr_w=$3; dr_h=$4
  ov_text="${ov_text}$dr_cx $dr_cy $dr_w $dr_h $5 $6 $7
"
}

# an erase rect — the device clears this area of the PERSISTENT HUD
# layer (transparent → the world shows through), so a cell or label can
# be redrawn without wiping the whole map. Args in milli (cx cy w h).
erase_rect() { er_cx=$1; er_cy=$2; er_w=$3; er_h=$4
  fmt_ndc $er_cx
  er_cxs=$fv
  fmt_ndc $er_cy
  er_cys=$fv
  fmt_pos $er_w
  er_ws=$fv
  fmt_pos $er_h
  er_hs=$fv
  ov_text="${ov_text}E $er_cxs $er_cys $er_ws $er_hs
"
}

# the viewmodel gun — a 3D-looking rectangular shape, bottom-right at 3/4
# across, drawn back so it pokes off the bottom-right edge, tilted 20°
# counter-clockwise. R-lines are rotated quads (R cx cy w h deg r g b)
# rendered by the device; the muzzle flash appears at the barrel tip
# after a shot.
draw_gun() {
  # receiver body (partially off the bottom/right edge) + top highlight
  # + barrel — STATIC, drawn once into the static layer (the muzzle
  # flash is per-frame and erased when it fades)
  ov_text="${ov_text}R 0.85 -0.95 0.40 0.30 20 0.24 0.26 0.30
"
  ov_text="${ov_text}R 0.85 -0.82 0.40 0.05 20 0.32 0.34 0.38
"
  # barrel: front face + left highlight + right shade (tilted +20°)
  ov_text="${ov_text}R 0.70 -0.50 0.16 0.90 20 0.30 0.33 0.38
"
  ov_text="${ov_text}R 0.665 -0.50 0.03 0.90 20 0.44 0.47 0.52
"
  ov_text="${ov_text}R 0.735 -0.50 0.03 0.90 20 0.15 0.16 0.18
"
}

# 3×5 pixel font — flat table of 38 glyphs × 15 pixels (row-major).
# Index: A-Z=0..25, 0-9=26..35, space=36, '/'=37
# 3×5 pixel font — flat table of 66 glyphs × 15 pixels (row-major).
# Index: A-Z=0..25, 0-9=26..35, space=36, '/'=37, '-'=38, '.'=39, a-z=40..65
GFONT=(1 1 1 1 0 1 1 1 1 1 0 1 1 0 1 1 1 0 1 0 1 1 1 0 1 0 1 1 1 0 1 1 1 1 0 0 1 0 0 1 0 0 1 1 1 1 1 0 1 0 1 1 0 1 1 0 1 1 1 0 1 1 1 1 0 0 1 1 0 1 0 0 1 1 1 1 1 1 1 0 0 1 1 0 1 0 0 1 0 0 1 1 1 1 0 0 1 1 1 1 0 1 1 1 1 1 0 1 1 0 1 1 1 1 1 0 1 1 0 1 1 1 1 0 1 0 0 1 0 0 1 0 1 1 1 0 0 1 0 0 1 0 0 1 1 0 1 1 1 1 1 0 1 1 1 0 1 0 0 1 1 0 1 0 1 1 0 0 1 0 0 1 0 0 1 0 0 1 1 1 1 0 1 1 1 1 1 1 1 1 0 1 1 0 1 1 0 1 1 1 1 1 0 1 1 0 1 1 0 1 1 1 1 1 0 1 1 0 1 1 0 1 1 1 1 1 1 0 1 0 1 1 1 0 1 0 0 1 0 0 1 1 1 1 0 1 1 0 1 1 1 0 1 1 1 1 1 0 1 0 1 1 1 0 1 0 1 1 0 1 1 1 1 1 0 0 1 1 1 0 0 1 1 1 1 1 1 1 0 1 0 0 1 0 0 1 0 0 1 0 1 0 1 1 0 1 1 0 1 1 0 1 1 1 1 1 0 1 1 0 1 1 0 1 1 0 1 0 1 0 1 0 1 1 0 1 1 1 1 1 1 1 1 0 1 1 0 1 1 0 1 0 1 0 1 0 1 1 0 1 1 0 1 1 0 1 0 1 0 0 1 0 0 1 0 1 1 1 0 0 1 0 1 0 1 0 0 1 1 1 1 1 1 1 0 1 1 0 1 1 0 1 1 1 1 0 1 0 1 1 0 0 1 0 0 1 0 1 1 1 1 1 1 0 0 1 1 1 1 1 0 0 1 1 1 1 1 1 0 0 1 1 1 1 0 0 1 1 1 1 1 0 1 1 0 1 1 1 1 0 0 1 0 0 1 1 1 1 1 0 0 1 1 1 0 0 1 1 1 1 1 1 1 1 0 0 1 1 1 1 0 1 1 1 1 1 1 1 0 0 1 0 1 0 0 1 0 0 1 0 1 1 1 1 0 1 1 1 1 1 0 1 1 1 1 1 1 1 1 0 1 1 1 1 0 0 1 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 1 0 1 0 1 0 0 1 0 0 0 0 0 0 0 0 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 1 1 0 1 1 0 1 1 1 1 1 0 0 1 0 0 1 1 0 1 0 1 1 1 0 0 0 0 1 1 1 1 0 0 1 0 0 1 1 1 0 0 1 0 0 1 1 0 1 1 0 1 1 1 1 0 0 0 1 1 1 1 0 1 1 1 0 1 1 1 0 0 1 0 1 1 0 1 0 0 1 0 0 1 0 0 0 0 1 1 1 1 0 1 1 1 1 0 0 1 1 0 0 1 0 0 1 1 0 1 0 1 1 0 1 0 1 0 0 0 0 0 1 0 0 1 0 0 1 0 0 0 1 0 0 0 0 0 1 0 0 1 1 1 1 1 0 0 1 0 1 1 1 0 1 0 1 1 0 1 1 0 0 1 0 0 1 0 0 1 0 0 0 1 1 0 0 0 1 0 1 1 1 1 1 1 1 1 0 1 0 0 0 1 1 0 1 0 1 1 0 1 1 0 1 0 0 0 1 1 1 1 0 1 1 0 1 1 1 1 0 0 0 1 1 0 1 0 1 1 1 0 1 0 0 0 0 0 1 0 1 1 0 1 1 1 1 0 0 1 0 0 0 0 0 0 1 1 0 1 0 1 1 0 0 0 0 0 1 1 1 1 0 0 0 0 1 1 1 1 0 1 0 0 1 0 1 1 1 0 1 0 0 0 1 0 0 0 0 0 0 1 0 1 1 0 1 1 1 1 0 0 0 0 0 0 1 0 1 1 0 1 0 1 0 0 0 0 0 0 0 1 0 1 1 1 1 1 1 1 0 0 0 0 0 0 1 0 1 0 1 0 1 0 1 0 0 0 1 0 1 1 0 1 1 1 1 0 0 1 0 0 0 0 0 0 1 1 1 0 1 0 1 1 1)

glyph_index() { gi_ch=$1
  case $gi_ch in
    A) gi=0 ;;
    B) gi=1 ;;
    C) gi=2 ;;
    D) gi=3 ;;
    E) gi=4 ;;
    F) gi=5 ;;
    G) gi=6 ;;
    H) gi=7 ;;
    I) gi=8 ;;
    J) gi=9 ;;
    K) gi=10 ;;
    L) gi=11 ;;
    M) gi=12 ;;
    N) gi=13 ;;
    O) gi=14 ;;
    P) gi=15 ;;
    Q) gi=16 ;;
    R) gi=17 ;;
    S) gi=18 ;;
    T) gi=19 ;;
    U) gi=20 ;;
    V) gi=21 ;;
    W) gi=22 ;;
    X) gi=23 ;;
    Y) gi=24 ;;
    Z) gi=25 ;;
    0) gi=26 ;;
    1) gi=27 ;;
    2) gi=28 ;;
    3) gi=29 ;;
    4) gi=30 ;;
    5) gi=31 ;;
    6) gi=32 ;;
    7) gi=33 ;;
    8) gi=34 ;;
    9) gi=35 ;;
    /) gi=37 ;;
    -) gi=38 ;;
    .) gi=39 ;;
    a) gi=40 ;;
    b) gi=41 ;;
    c) gi=42 ;;
    d) gi=43 ;;
    e) gi=44 ;;
    f) gi=45 ;;
    g) gi=46 ;;
    h) gi=47 ;;
    i) gi=48 ;;
    j) gi=49 ;;
    k) gi=50 ;;
    l) gi=51 ;;
    m) gi=52 ;;
    n) gi=53 ;;
    o) gi=54 ;;
    p) gi=55 ;;
    q) gi=56 ;;
    r) gi=57 ;;
    s) gi=58 ;;
    t) gi=59 ;;
    u) gi=60 ;;
    v) gi=61 ;;
    w) gi=62 ;;
    x) gi=63 ;;
    y) gi=64 ;;
    z) gi=65 ;;
    *) gi=36 ;;
  esac
}
# draw one glyph at (basex, basey) milli with pixel size px×py
draw_char() { dg=$1; dbx=$2; dby=$3; dpx=$4; dpy=$5
  dk=0
  while [ "$dk" -lt 15 ]; do
    dgi=$((dg*15+dk))
    dpix=${GFONT[$dgi]}
    if [ "$dpix" -eq 1 ]; then
      dcol=$((dk % 3))
      drow=$((dk / 3))
      dcxm=$((dbx + dcol*dpx))
      dcym=$((dby - drow*dpy))
      fmt_ndc $dcxm
      dcxs=$fv
      fmt_ndc $dcym
      dcys=$fv
      draw_rect $dcxs $dcys $GLP_W $GLP_H $6 $7 $8
    fi
    dk=$((dk + 1))
  done
}

# draw a fixed-length text string (len passed — ${#…} doesn't expand
# in this pipeline)
draw_text() { dt_t=$1; dt_len=$2; dt_x=$3; dt_y=$4; dt_px=$5; dt_py=$6
  dt_i=0
  while [ "$dt_i" -lt "$dt_len" ]; do
    dt_ch=${dt_t:$dt_i:1}
    glyph_index $dt_ch
    draw_char $gi $dt_x $dt_y $dt_px $dt_py $7 $8 $9
    dt_x=$((dt_x + 4*dt_px))
    dt_i=$((dt_i + 1))
  done
}

# 16×16 radar, top-right corner. The static base (walls + treasure
# cells) is prebuilt into hud_static once — this draws only the DYNAMIC
# part: the player triangle and the living MIMEs (they move). Air cells
# stay dark (the base skips them), so nothing overlaps.
# the radar base cell (wall grey / treasure green) at a map cell —
# used to restore cells that a wide rotate-erase wiped from the static
# layer. Air cells draw nothing (they are transparent).
draw_radar_cell() { rc_x=$1; rc_z=$2
  # the radar shows the MAZE — layer y=1 (the base's layer; y=0 is the
  # dirt floor and would paint every walkable cell grey)
  get_cell $rc_x 1 $rc_z
  if [ "$gv" -eq "$TREASURE" ]; then rc_r=0.20; rc_g=1.00; rc_b=0.45
  elif [ "$gv" -ne "$AIR" ]; then rc_r=0.42; rc_g=0.42; rc_b=0.47
  else return 0
  fi
  rc_cxm=$((RADAR_X + rc_x*44))
  rc_cym=$((1720 - rc_z*60))
  fmt_ndc $rc_cxm
  rc_cxs=$fv
  fmt_ndc $rc_cym
  rc_cys=$fv
  draw_rect $rc_cxs $rc_cys $CELL_W $CELL_H $rc_r $rc_g $rc_b
}

# the mime's radar blip (ring + coloured core) at its current cell
draw_mime_blip() { mb_i=$1
  mime_color ${mtype[$mb_i]}
  # read the array element to a variable FIRST — a ${arr[$i]} read
  # inside $(( )) transpiles wrong (the debashcl emitter escapes the
  # outer $ and the runtime's arith mis-expands it; precomputed scalar
  # variables are the game's own discipline)
  mb_mx=${mx[$mb_i]}
  mb_mz=${mz[$mb_i]}
  mb_cxm=$((RADAR_X + mb_mx*44))
  mb_cym=$((1720 - mb_mz*60))
  fmt_ndc $mb_cxm
  mb_cxs=$fv
  fmt_ndc $mb_cym
  mb_cys=$fv
  draw_rect $mb_cxs $mb_cys 0.075 0.100 0.10 0.10 0.12
  draw_rect $mb_cxs $mb_cys 0.050 0.070 $cr $cg $cb
}

draw_minimap() {
  # the radar BASE (walls + treasure cells) is in the static layer —
  # per frame only the CHANGED squares update: erase the old cell, draw
  # the new. The player is a triangle pointing the way they face
  # (yaw 0 = up on the radar = -z, the world direction the camera
  # starts in); display yaw (unwrapped, can be negative) so it glides
  # through the SHORT arc during a turn, mirroring the view.
  dm_deg=$((dpyw_raw_ms / 1000))
  if [ "$prev_px" -ne "$dpx" ] || [ "$prev_pz" -ne "$dpz" ] || [ "$prev_deg" -ne "$dm_deg" ]; then
    if [ "$prev_px" -ge 0 ]; then
      if [ "$prev_deg" -ne "$dm_deg" ]; then
        # rotating: the triangle's corners sweep into the LEFT/RIGHT
        # neighbour cells — erase the whole 3-cell row, then restore the
        # base cells (walls/treasures) and any mimes that were wiped
        erase_rect $((RADAR_X + prev_px*44)) $((1720 - prev_pz*60)) 132 64
        draw_radar_cell $((prev_px - 1)) $prev_pz
        draw_radar_cell $prev_px $prev_pz
        draw_radar_cell $((prev_px + 1)) $prev_pz
        dm_ai=0
        while [ "$dm_ai" -lt "$mime_count" ]; do
          dm_mx=${mx[$dm_ai]}
          dm_mz=${mz[$dm_ai]}
          if [ "$dm_mz" -eq "$prev_pz" ]; then
            if [ "$dm_mx" -eq "$prev_px" ] || [ "$dm_mx" -eq "$((prev_px - 1))" ] || [ "$dm_mx" -eq "$((prev_px + 1))" ]; then
              draw_mime_blip $dm_ai
            fi
          fi
          dm_ai=$((dm_ai + 1))
        done
      else
        # a move (angle unchanged): the triangle fits a 64 box
        erase_rect $((RADAR_X + prev_px*44)) $((1720 - prev_pz*60)) 64 64
      fi
    fi
    prev_px=$dpx
    prev_pz=$dpz
    prev_deg=$dm_deg
  fi
  dm_cxm=$((RADAR_X + dpx*44))
  dm_cym=$((1720 - dpz*60))
  fmt_ndc $dm_cxm
  dm_cxs=$fv
  fmt_ndc $dm_cym
  dm_cys=$fv
  ov_text="${ov_text}T $dm_cxs $dm_cys 0.042 1.0 1.0 1.0 $dm_deg
"
  # mimes — bright red blips (ring + coloured core); only MOVED cells
  # are erased and redrawn (they step every MIME_STEP frames)
  mi=0
  while [ "$mi" -lt "$mime_count" ]; do
    dm_mx=${mx[$mi]}
    dm_mz=${mz[$mi]}
    dm_rmx=${rmx[$mi]}
    dm_rmz=${rmz[$mi]}
    if [ "$dm_rmx" -ne "$dm_mx" ] || [ "$dm_rmz" -ne "$dm_mz" ]; then
      if [ "$dm_rmx" -ge 0 ]; then
        erase_rect $((RADAR_X + dm_rmx*44)) $((1720 - dm_rmz*60)) 80 105
      fi
      rmx[$mi]=$dm_mx
      rmz[$mi]=$dm_mz
      draw_mime_blip $mi
    fi
    mi=$((mi + 1))
  done
}

# MIMEs carry their own type TEXTURE on the cube (texture-jpeg/png/octet/
# text — indices 11-14), so there are no name tags on the HUD: the radar
# shows a colour-coded blip, the cube shows the type's icon.
# the whole on-canvas dashboard: score line, radar, instructions
hud_static=""
hud_static_dirty=1   # the radar base must be built before the first frame
digits_dirty=1       # the score/hp/art/fps digits — redrawn only when they change
flash_clear=0        # erase the muzzle flash after the last flash frame
prev_px=-1           # the player's previous radar cell (for the erase)
prev_pz=-1
prev_deg=-1          # the triangle's previous rotation (turning rotates in place)
rmx=(-1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1)   # mime radar cells already drawn (-1 = none)
rmz=(-1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1)
# build the never-changing HUD parts (labels, separators, instructions,
# radar base cells) ONCE into hud_static; draw_hud_canvas() re-sends it
# every rendered frame with a leading "C" (the device clears its HUD
# layer first), so the per-frame bash cost is only the dynamic cells —
# no ghosting, and the device composites the layer as one textured quad
# per swap. The radar BASE (walls + treasure cells) never moves; only
# the player triangle and the MIMEs change per frame, so those are the
# dynamic part. hud_static is rebuilt (hud_static_dirty=1) only when a
# block is mined or a treasure claimed.
hud_build_static() {
  ov_text=""
  # score line (top-left)
  draw_text "SCORE" 5 60 1840 8 11 0.95 0.85 0.30
  # HP line
  draw_text "HP" 2 400 1840 8 11 0.35 0.90 0.40
  draw_char 37 560 1840 8 11 0.35 0.90 0.40
  # ART line
  draw_text "ART" 3 760 1840 8 11 0.60 0.75 0.95
  draw_char 37 952 1840 8 11 0.60 0.75 0.95
  # fps label
  draw_text "FPS" 3 60 1778 8 11 0.55 0.95 0.95
  # instructions (bottom centre)
  draw_text "WASD MOVE ARROWS TURN SPACE SHOOT" 33 538 100 7 10 0.85 0.85 0.85
  # radar base: walls + treasure cells (air stays dark; the player and
  # MIMEs are air cells, drawn dynamically over this base each frame)
  dm_x=0
  while [ "$dm_x" -lt "$MAP_W" ]; do
    dm_z=0
    while [ "$dm_z" -lt "$MAP_D" ]; do
      # the maze lives on layer y=1 (corridors carved there; y=0 is the
      # solid dirt floor) — reading y=0 painted every cell as a wall
      get_cell $dm_x 1 $dm_z
      dm_draw=0
      if [ "$gv" -eq "$TREASURE" ]; then dm_r=0.20; dm_g=1.00; dm_b=0.45; dm_draw=1
      elif [ "$gv" -ne "$AIR" ]; then dm_r=0.42; dm_g=0.42; dm_b=0.47; dm_draw=1
      fi
      if [ "$dm_draw" -eq 1 ]; then
        dm_cxm=$((RADAR_X + dm_x*44))
        dm_cym=$((1720 - dm_z*60))
        fmt_ndc $dm_cxm
        dm_cxs=$fv
        fmt_ndc $dm_cym
        dm_cys=$fv
        draw_rect $dm_cxs $dm_cys $CELL_W $CELL_H $dm_r $dm_g $dm_b
      fi
      dm_z=$((dm_z + 1))
    done
    dm_x=$((dm_x + 1))
  done
  # the viewmodel gun (static) and the sightings list (changes only
  # when mimes spawn/die — hud_static_dirty) join the base layer
  draw_gun
  hud_static=$ov_text
  # write the whole static layer ONCE (with a clear); per-frame hud
  # writes update only the changed cells on top of it
  ov_text="C
"
  ov_text="$ov_text$hud_static"
  echo "$ov_text" > /dev/webgl/hud
}

# the score/hp/art/fps digit groups — erase + redraw only when a value
# changed (digits_dirty); the digits are small, so the per-frame cost is
# zero most frames
draw_digits() {
  # erase the four groups (score / HP / ART / FPS)
  erase_rect 296 1812 96 60
  erase_rect 572 1812 160 60
  erase_rect 964 1812 160 60
  erase_rect 240 1750 96 60
  # score digits
  dh_a=$((score/100%10+26))
  dh_b=$((score/10%10+26))
  dh_c=$((score%10+26))
  draw_char $dh_a 252 1840 8 11 0.95 0.85 0.30
  draw_char $dh_b 284 1840 8 11 0.95 0.85 0.30
  draw_char $dh_c 316 1840 8 11 0.95 0.85 0.30
  # HP digits (current / max)
  dh_a=$((hp/10+26))
  dh_b=$((hp%10+26))
  draw_char $dh_a 496 1840 8 11 0.35 0.90 0.40
  draw_char $dh_b 528 1840 8 11 0.35 0.90 0.40
  dh_a=$((maxhp/10+26))
  dh_b=$((maxhp%10+26))
  draw_char $dh_a 592 1840 8 11 0.35 0.90 0.40
  draw_char $dh_b 624 1840 8 11 0.35 0.90 0.40
  # ART digits (found / total)
  dh_a=$((found_count/10+26))
  dh_b=$((found_count%10+26))
  draw_char $dh_a 888 1840 8 11 0.60 0.75 0.95
  draw_char $dh_b 920 1840 8 11 0.60 0.75 0.95
  dh_a=$((TREASURE_TOTAL/10+26))
  dh_b=$((TREASURE_TOTAL%10+26))
  draw_char $dh_a 984 1840 8 11 0.60 0.75 0.95
  draw_char $dh_b 1016 1840 8 11 0.60 0.75 0.95
  # fps digits (second line, below the score)
  dh_a=$((fps/100+26))
  dh_b=$((fps/10%10+26))
  dh_c=$((fps%10+26))
  draw_char $dh_a 196 1778 8 11 0.55 0.95 0.95
  draw_char $dh_b 228 1778 8 11 0.55 0.95 0.95
  draw_char $dh_c 260 1778 8 11 0.55 0.95 0.95
}

draw_hud_canvas() {
  if [ "$hud_static_dirty" -eq 1 ]; then
    hud_build_static
    hud_static_dirty=0
    # the rebuild wiped the whole layer — reset the dynamic-cell state
    # so the triangle, mime blips and labels are redrawn this frame
    prev_px=-1
    prev_pz=-1
    prev_deg=-1
    dm_i=0
    while [ "$dm_i" -lt "$MIME_CAP" ]; do
      rmx[$dm_i]=-1
      rmz[$dm_i]=-1
      dm_i=$((dm_i + 1))
    done
    digits_dirty=1
  fi
  ov_text=""
  # the muzzle flash fades: erase the whole rotated flash (its 0.22 box
  # rotated 20° spans ~0.28) then REDRAW the gun — the erase overlaps
  # the barrel tip, and the gun lives in the static layer, so without
  # the redraw a chunk of the gun would stay erased
  if [ "$flash_clear" -eq 1 ]; then
    ov_text="${ov_text}E 0.55 -0.08 0.32 0.32
"
    draw_gun
    flash_clear=0
  fi
  draw_minimap
  if [ "$muzzle" -gt 0 ]; then
    ov_text="${ov_text}R 0.55 -0.08 0.22 0.22 20 1.0 0.82 0.2
"
    ov_text="${ov_text}R 0.55 -0.08 0.10 0.10 20 1.0 1.0 0.9
"
  fi
  if [ "$digits_dirty" -eq 1 ]; then
    draw_digits
    digits_dirty=0
  fi
  if [ "$ov_text" != "" ]; then
    echo "$ov_text" > /dev/webgl/hud
  fi
}

print_map_once() {
  if [ -f /tmp/mimecroft-map-shown ]; then return 0; fi
  echo "shown" > /tmp/mimecroft-map-shown
  echo ""
  echo "MIMEcroft  artifacts $found_count/$TREASURE_TOTAL  hp $hp/$maxhp  score $score  mimes $mime_count"
  po_z=0
  while [ "$po_z" -lt "$MAP_D" ]; do
    po_line=""
    po_x=0
    while [ "$po_x" -lt "$MAP_W" ]; do
      if [ "$po_x" -eq "$px" ] && [ "$po_z" -eq "$pz" ]; then
        po_ch="@"
      else
        get_cell $po_x 1 $po_z
        if [ "$gv" -eq "$AIR" ]; then po_ch="."
        elif [ "$gv" -eq "$TREASURE" ]; then po_ch="?"
        else po_ch="#"
        fi
      fi
      po_line="$po_line$po_ch"
      po_x=$((po_x + 1))
    done
    echo "  $po_line"
    po_z=$((po_z + 1))
  done
  echo ""
}

# ─── Main ───────────────────────────────────────────────────────────
# ─── frame stats ────────────────────────────────────────────────────
# a cheap µs clock: EPOCHREALTIME (host bash / real-bash wasm) with a
# `date +%s%N` fallback (the transpiled shell returns Date.now()*1e6 —
# fine for relative deltas). g_now = integer microseconds.
gtick() {
  g_now=$EPOCHREALTIME
  if [ "$g_now" != "" ]; then
    g_now=${g_now%.*}${g_now#*.}
  else
    g_now=$(date +%s%N 2>/dev/null)
    if [ "$g_now" != "" ]; then g_now=$(( g_now / 1000 )); fi
  fi
  if [ "$g_now" = "" ]; then g_now=0; fi
}

# per-phase accumulators (µs) — what holds the frame rate back, by how
# much: input / anim / display / mimes / render / hud / swap / sleep
g_in=0
g_anim=0
g_disp=0
g_mime=0
g_render=0
g_hud=0
g_swap=0
g_sleep=0

# accumulate the µs since the last gspan into a named bucket
gspan() {
  gs_name=$1
  gtick
  gs_d=$(( g_now - g_last ))
  if [ "$gs_name" = "input" ]; then g_in=$(( g_in + gs_d )); fi
  if [ "$gs_name" = "anim" ]; then g_anim=$(( g_anim + gs_d )); fi
  if [ "$gs_name" = "disp" ]; then g_disp=$(( g_disp + gs_d )); fi
  if [ "$gs_name" = "mime" ]; then g_mime=$(( g_mime + gs_d )); fi
  if [ "$gs_name" = "render" ]; then g_render=$(( g_render + gs_d )); fi
  if [ "$gs_name" = "hud" ]; then g_hud=$(( g_hud + gs_d )); fi
  if [ "$gs_name" = "swap" ]; then g_swap=$(( g_swap + gs_d )); fi
  if [ "$gs_name" = "sleep" ]; then g_sleep=$(( g_sleep + gs_d )); fi
  g_last=$g_now
}

# ─── pre-game settings menu (browser only — the headless device has
#     no real keys and the tests drive the game directly) ────────────
# The device captures keys only while the canvas is visible and a swap
# happened < 2s ago, so the menu shows the canvas (first swap) and keeps
# swapping. W/S select · A/D change · SPACE start · Q quit.
settings_inc() {
  if [ "$sm_sel" -eq 0 ]; then
    # no limit — the camera may shift arbitrarily far, even negative
    cam_shift_ms=$((cam_shift_ms + 50))
  fi
  if [ "$sm_sel" -eq 1 ]; then
    if [ "$tex_size" -eq 4 ]; then tex_size=8
    elif [ "$tex_size" -eq 8 ]; then tex_size=16
    elif [ "$tex_size" -eq 16 ]; then tex_size=32
    elif [ "$tex_size" -eq 32 ]; then tex_size=64
    fi
  fi
  if [ "$sm_sel" -eq 2 ]; then
    sm_nv=$((tex_seed + 1000))
    if [ "$sm_nv" -le 99999999 ]; then tex_seed=$sm_nv; fi
  fi
  if [ "$sm_sel" -eq 3 ]; then
    CRT_ON=1
  fi
  if [ "$sm_sel" -eq 4 ]; then
    CORRUPT_ON=1
  fi
}

settings_dec() {
  if [ "$sm_sel" -eq 0 ]; then
    cam_shift_ms=$((cam_shift_ms - 50))
  fi
  if [ "$sm_sel" -eq 1 ]; then
    if [ "$tex_size" -eq 64 ]; then tex_size=32
    elif [ "$tex_size" -eq 32 ]; then tex_size=16
    elif [ "$tex_size" -eq 16 ]; then tex_size=8
    elif [ "$tex_size" -eq 8 ]; then tex_size=4
    fi
  fi
  if [ "$sm_sel" -eq 2 ]; then
    sm_nv=$((tex_seed - 1000))
    if [ "$sm_nv" -ge 1 ]; then tex_seed=$sm_nv; fi
  fi
  if [ "$sm_sel" -eq 3 ]; then
    CRT_ON=0
  fi
  if [ "$sm_sel" -eq 4 ]; then
    CORRUPT_ON=0
  fi
}

# the menu card: terminal (values + cursor) and canvas (labels, the
# live VALUES and a bright cursor block — the pixel font needs a fixed
# glyph count, so the variable-width seed gets its digit count computed)
draw_settings_menu() {
  echo ""
  echo "  ╔═══════════ SETTINGS ═══════════╗"
  echo "  ║  ↑↓ select · ←→ change         ║"
  echo "  ║  SPACE/ESC start · Q quit      ║"
  echo "  ╚════════════════════════════════╝"
  if [ "$sm_sel" -eq 0 ]; then sm_mark=">"; else sm_mark=" "; fi
  fmt_pos $cam_shift_ms
  echo "  $sm_mark  camera shift : $fv"
  if [ "$sm_sel" -eq 1 ]; then sm_mark=">"; else sm_mark=" "; fi
  echo "  $sm_mark  texture size : $tex_size"
  if [ "$sm_sel" -eq 2 ]; then sm_mark=">"; else sm_mark=" "; fi
  echo "  $sm_mark  texture seed : $tex_seed"
  if [ "$sm_sel" -eq 3 ]; then sm_mark=">"; else sm_mark=" "; fi
  if [ "$CRT_ON" -eq 1 ]; then sm_crt="ON"; else sm_crt="OFF"; fi
  echo "  $sm_mark  CRT effect   : $sm_crt"
  if [ "$sm_sel" -eq 4 ]; then sm_mark=">"; else sm_mark=" "; fi
  if [ "$CORRUPT_ON" -eq 1 ]; then sm_crp="ON"; else sm_crp="OFF"; fi
  echo "  $sm_mark  corruption  : $sm_crp"
  # canvas card — the leading C must be on its OWN line (a real
  # newline) or the device never clears the layer and old rects stay
  sm_shift_s=$fv
  # the store types are sticky — coerce the numbers to strings via
  # echo (the pixel font draws chars, so the text arg must be a string)
  sm_size_s=$(echo "$tex_size")
  sm_seed_s=$(echo "$tex_seed")
  sm_slen=1
  if [ "$tex_seed" -ge 10000000 ]; then sm_slen=8
  elif [ "$tex_seed" -ge 1000000 ]; then sm_slen=7
  elif [ "$tex_seed" -ge 100000 ]; then sm_slen=6
  elif [ "$tex_seed" -ge 10000 ]; then sm_slen=5
  elif [ "$tex_seed" -ge 1000 ]; then sm_slen=4
  elif [ "$tex_seed" -ge 100 ]; then sm_slen=3
  elif [ "$tex_seed" -ge 10 ]; then sm_slen=2
  fi
  if [ "$CRT_ON" -eq 1 ]; then sm_crt_s="ON"; sm_crt_len=2; else sm_crt_s="OFF"; sm_crt_len=3; fi
  if [ "$CORRUPT_ON" -eq 1 ]; then sm_crp_s="ON"; sm_crp_len=2; else sm_crp_s="OFF"; sm_crp_len=3; fi
  ov_text="C
"
  draw_text "SETTINGS" 8 840 1750 10 14 0.95 0.85 0.30
  draw_text "CAM SHIFT" 9 560 1600 8 11 0.60 0.75 0.95
  draw_text "TEXTURE SIZE" 12 560 1500 8 11 0.60 0.75 0.95
  draw_text "TEXTURE SEED" 12 560 1400 8 11 0.60 0.75 0.95
  draw_text "CRT EFFECT" 10 560 1300 8 11 0.60 0.75 0.95
  draw_text "CORRUPTION" 10 560 1200 8 11 0.60 0.75 0.95
  draw_text $sm_shift_s 5 1000 1600 8 11 0.95 0.95 0.95
  draw_text $sm_size_s 2 1000 1500 8 11 0.95 0.95 0.95
  draw_text $sm_seed_s $sm_slen 1000 1400 8 11 0.95 0.95 0.95
  draw_text $sm_crt_s $sm_crt_len 1000 1300 8 11 0.95 0.95 0.95
  draw_text $sm_crp_s $sm_crp_len 1000 1200 8 11 0.95 0.95 0.95
  if [ "$sm_sel" -eq 0 ]; then draw_rect "-0.520" "0.583" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 1 ]; then draw_rect "-0.520" "0.483" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 2 ]; then draw_rect "-0.520" "0.383" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 3 ]; then draw_rect "-0.520" "0.283" "0.016" "0.030" 1.0 0.85 0.30
  else draw_rect "-0.520" "0.183" "0.016" "0.030" 1.0 0.85 0.30; fi
  draw_text "UP/DOWN SELECT - LEFT/RIGHT CHANGE" 34 340 250 7 10 0.85 0.85 0.85
  draw_text "SPACE/ESC START - Q QUIT" 24 500 180 7 10 0.85 0.85 0.85
  echo "$ov_text" > /dev/webgl/hud
}

settings_menu() {
  if [ "$headless" -eq 1 ]; then return; fi
  sm_mode=$1
  sm_size_old=$tex_size
  sm_seed_old=$tex_seed
  sm_crt_old=$CRT_ON
  sm_corrupt_old=$CORRUPT_ON
  # show the canvas first so /dev/webgl/key starts capturing. The HUD
  # composite BLENDS the layer over the back buffer and the drawing
  # buffer is preserved now (preserveDrawingBuffer:true) — so the back
  # buffer must be CLEARED before every present or the old card (dots,
  # digits) stays visible underneath the new one.
  echo "clear" > /dev/webgl/call
  echo "swap" > /dev/webgl/call
  draw_settings_menu
  sm_done=0
  while [ "$sm_done" -eq 0 ]; do
    sm_keys=$(cat /dev/webgl/key)
    if [ "$sm_keys" != "" ]; then
      sm_changed=0
      case $sm_keys in
        *space*)
          sm_done=1
          ;;
        *Escape*)
          sm_done=1
          ;;
        *q*)
          quit=1
          sm_done=1
          ;;
        # ←/→ change the CURRENT item's value (like A/D). They must be
        # matched before *w*/*a* — "ArrowLeft" contains 'w' and 'a'
        *ArrowLeft*)
          settings_dec
          sm_changed=1
          ;;
        *ArrowRight*)
          settings_inc
          sm_changed=1
          ;;
        *ArrowUp*)
          sm_sel=$((sm_sel - 1))
          if [ "$sm_sel" -lt 0 ]; then sm_sel=4; fi
          sm_changed=1
          ;;
        *ArrowDown*)
          sm_sel=$((sm_sel + 1))
          if [ "$sm_sel" -gt 4 ]; then sm_sel=0; fi
          sm_changed=1
          ;;
        *w*)
          sm_sel=$((sm_sel - 1))
          if [ "$sm_sel" -lt 0 ]; then sm_sel=4; fi
          sm_changed=1
          ;;
        *s*)
          sm_sel=$((sm_sel + 1))
          if [ "$sm_sel" -gt 4 ]; then sm_sel=0; fi
          sm_changed=1
          ;;
        *d*)
          settings_inc
          sm_changed=1
          ;;
        *a*)
          settings_dec
          sm_changed=1
          ;;
      esac
      if [ "$sm_changed" -eq 1 ]; then
        draw_settings_menu
      fi
    fi
    # wipe the back buffer before presenting (see above)
    echo "clear" > /dev/webgl/call
    echo "swap" > /dev/webgl/call
    sleep 0.05
  done
  # push the camera shift to the GPU (setup_webgl also writes it)
  fmt_pos $cam_shift_ms
  echo "$fv" > /dev/webgl/uniform/1f/uCamShift
  if [ "$sm_mode" = "live" ]; then
    # mid-game: apply the settings NOW — the fragment shader encodes the
    # CRT/corruption effects AND the texel grid size, so re-emit it when
    # any of those changed; a resolution/seed change also needs the new
    # textures
    if [ "$tex_size" -ne "$sm_size_old" ] || [ "$CRT_ON" -ne "$sm_crt_old" ] || [ "$CORRUPT_ON" -ne "$sm_corrupt_old" ]; then
      emit_fragment_shader
    fi
    if [ "$tex_size" -ne "$sm_size_old" ] || [ "$tex_seed" -ne "$sm_seed_old" ]; then
      echo "  regenerating textures…"
      load_textures
      # the loading-screen previews were drawn onto the persistent HUD
      # layer (no clear) — rebuild the static base so they are wiped
      # and the radar/triangle/mimes/digits return next frame
      hud_static_dirty=1
    fi
  fi
  echo ""
  echo "  settings: camera shift $fv · textures ${tex_size}px · seed $tex_seed"
}

main() {
  st=$(cat /dev/webgl/state)
  case $st in
    *headless*) sound=$((0)); headless=1 ;;
    *) sound=$((1)); headless=0 ;;
  esac
  gtick
  g_t0=$g_now
  # immediate feedback FIRST: the banner + map print before the slow
  # parts (the wasm shader compile + the texture generation), so the
  # terminal is never silent during startup. The sleeps between phases
  # are macrotask yields — the browser can't PAINT while a transpiled
  # script runs (its exec calls are one microtask chain), so without
  # them every startup message appears at once when the game loop
  # starts instead of streaming as it loads.
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  MIMEcrofT v5.9 — 3D treasure hunt written in bash ║"
  echo "║  The filesystem is infested with evil MIMEs.     ║"
  echo "║  Recover the lost operating systems.             ║"
  echo "║  WASD move · arrows turn · SPACE shoot · q quit  ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""
  sleep 0.02
  print_map_once
  sleep 0.02
  if [ "$headless" -eq 0 ]; then
    settings_menu
    if [ "$quit" -eq 1 ]; then
      echo "== Quit."
      echo "hide" > /dev/webgl/call
      return
    fi
    sleep 0.02
  fi
  echo "  compiling the fragment shader…"
  sleep 0.02
  setup_webgl
  gen_maze
  place_treasures
  # the radar base needs the maze — build it now (after gen/placement),
  # not before, so the first static layer has the real walls/treasures
  hud_build_static
  hud_static_dirty=0
  if [ "$MIMES_ON" -eq 1 ]; then
    spawn_mime
    spawn_mime
    spawn_mime
  fi
  # block textures (generated by examples/textures at startup — cached
  # in /tmp per session so re-runs skip the generation)
  echo "  loading block textures…"
  sleep 0.02
  load_textures
  echo "  ready."
  sleep 0.8
  frame=$((0))
  quit=$((0))
  dirty=1
  while [ "$quit" -eq 0 ] && [ "$hp" -gt 0 ] && [ "$found_count" -lt "$TREASURE_TOTAL" ]; do
    frame=$((frame + 1))
    gtick
    g_last=$g_now
    fp_t0=$g_now
    # one action at a time: input is queued until the current glide ends
    if [ "$anim" -eq 0 ]; then
      keys=$(cat /dev/webgl/key)
      fx=${DIR_X[$yaw]}
      fz=${DIR_Z[$yaw]}
      bx=$((0 - fx))
      bz=$((0 - fz))
      case $keys in
        *q*)
          quit=$((1))
          ;;
        # Esc opens the settings menu mid-game (pause); Esc/SPACE close it
        *Escape*)
          settings_menu live
          dirty=1
          ;;
        *space*)
          shoot
          dirty=1
          ;;
        *ArrowLeft*)
          start_turn 3
          ;;
        *ArrowRight*)
          start_turn 1
          ;;
        # ArrowUp/ArrowDown contain the letter 'w' — they must be matched
        # BEFORE *w*/*s* or both would fall through to "move forward"
        *ArrowUp*)
          try_anim_move $fx $fz
          ;;
        *ArrowDown*)
          try_anim_move $bx $bz
          ;;
        *w*)
          try_anim_move $fx $fz
          ;;
        *s*)
          try_anim_move $bx $bz
          ;;
        *a*)
          try_anim_move $fz $bx
          ;;
        *d*)
          try_anim_move $bz $fx
          ;;
      esac
      if [ "$anim" -eq 1 ]; then
        dirty=1
      fi
    fi
    gspan "input"
    # advance the camera glide by wall time; snap the discrete state
    # when the 0.2s action completes (keys unlock for the next action)
    if [ "$anim" -eq 1 ]; then
      anim_now=$(cat /dev/time)
      anim_el=$((anim_now - anim_t0))
      dirty=1
      if [ "$anim_el" -ge "$anim_ms" ]; then
        px=$ax1
        pz=$az1
        yaw=$ay1
        anim=0
      fi
    fi
    gspan "anim"
    compute_display
    # the eye ducks/steps up as the cell overhead changes (cheap: one
    # cell read; render_frame reads crouched for the camera height)
    update_crouch
    # muzzle flash lifetime: a few loop frames of flash, then force a
    # clear render so the flash doesn't linger frozen on a static scene
    if [ "$muzzle" -gt 0 ]; then
      muzzle=$((muzzle - 1))
      if [ "$muzzle" -eq 0 ]; then
        flash_clear=1
        dirty=1
      fi
    fi
    gspan "disp"
    mstep=$((frame % MIME_STEP))
    if [ "$MIMES_ON" -eq 1 ]; then
      if [ "$mstep" -eq 0 ]; then
        update_mimes
        dirty=1
      fi
    fi
    gspan "mime"
    # Render only when the world changed (key action or mime step): a
    # complete frame — world + HUD + swap — is produced atomically, and
    # the canvas (double-buffered by the browser) keeps showing the last
    # presented frame in between. The 100fps loop stays for input
    # latency; rendering every frame at ~48ms of async dispatches would
    # cap the game at ~20fps and waste the static frames.
    if [ "$dirty" -eq 1 ]; then
      render_frame
      gspan "render"
      draw_hud_canvas
      gspan "hud"
      echo "swap" > /dev/webgl/call
      gspan "swap"
      dirty=0
      fps_rendered=$((fps_rendered + 1))
    else
      # keyboard heartbeat: the device releases keys 2s after the last
      # swap — a bare swap (the back buffer is unchanged) every ~1s
      # keeps the game's keyboard grab alive while idling. (frame % 100
      # at ~10ms/frame ≈ 1s — comfortably inside the 2s window even
      # when a render burst slows a few frames; 190 was ~1.5s+overhead,
      # so the window expired on slow machines and keys stopped arriving)
      hb=$((frame % 100))
      if [ "$hb" -eq 0 ]; then
        echo "swap" > /dev/webgl/call
      fi
    fi
    # fps: rendered frames per wall-second, sampled every 10 frames
    fps_w=$((frame % 10))
    if [ "$fps_w" -eq 0 ]; then
      fps_t=$(cat /dev/time)
      if [ "$fps_t0" -gt 0 ]; then
        fps_dt=$((fps_t - fps_t0))
        if [ "$fps_dt" -gt 0 ] && [ "$fps_rendered" -gt 0 ]; then
          fps=$((fps_rendered * 1000 / fps_dt))
          digits_dirty=1
        fi
        fps_rendered=0
      fi
      fps_t0=$fps_t
    fi
    # fps cap 100 (10ms/frame): sleep the leftover budget, or a minimum
    # 1ms yield on a slow frame — the browser CANNOT paint (terminal or
    # canvas) while the transpiled script runs its microtask chain, so a
    # frame that never sleeps freezes the display until the game exits.
    gtick
    fp_el=$((g_now - fp_t0))
    if [ "$fp_el" -lt 10000 ]; then
      fp_wait=$(((10000 - fp_el + 999) / 1000))
    else
      fp_wait=1
    fi
    fmt3 $fp_wait
    sleep 0.$fv
    fp_t0=$g_now
    # the sleep itself + the fps-sampling tail of the frame
    gspan "sleep"
  done
  echo "hide" > /dev/webgl/call
  echo ""
  if [ "$quit" -eq 1 ]; then
    echo "== Quit. Score $score — $found_count artifacts recovered. =="
  elif [ "$found_count" -ge "$TREASURE_TOTAL" ]; then
    echo "▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒"
    echo "▒  VICTORY — all $TREASURE_TOTAL operating systems recovered!  ▒"
    echo "▒  The filesystem is pure again.  Final score: $score         ▒"
    echo "▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒"
  else
    echo "╔════════════════════════════════════════════╗"
    echo "║  GAME OVER — the MIMEs got you.             ║"
    echo "║  $found_count / $TREASURE_TOTAL artifacts recovered.  ║"
    echo "║  Score: $score                             ║"
    echo "╚════════════════════════════════════════════╝"
  fi
  gtick
  g_total=$(( g_now - g_t0 ))
  if [ "$frame" -gt 0 ]; then
    g_total_ms=$(( g_total / 1000 ))
    g_avg_ms=$(( g_total / frame / 1000 ))
    echo "#stats: frames=$frame time=${g_total_ms}ms avg=${g_avg_ms}ms/frame"
    # per-phase breakdown: ms/frame and % of frame time, plus "other"
    # (unmeasured loop overhead + the gspan ticks themselves)
    g_sum=$(( g_in + g_anim + g_disp + g_mime + g_render + g_hud + g_swap + g_sleep ))
    g_other=$(( g_total - g_sum ))
    if [ "$g_other" -lt 0 ]; then g_other=0; fi
    g_ff=$(( g_total / frame ))
    if [ "$g_ff" -lt 1 ]; then g_ff=1; fi
    fmt_gms() {
      fg_v=$1
      fg_ms=$(( fg_v / frame / 1000 ))
      echo "$fg_ms"
    }
    fmt_gp() {
      fp_v=$1
      echo "$(( fp_v * 100 / g_total ))"
    }
    echo "#stats:   input=$(fmt_gms $g_in)ms/f($(fmt_gp $g_in)%) anim=$(fmt_gms $g_anim)ms/f($(fmt_gp $g_anim)%) disp=$(fmt_gms $g_disp)ms/f($(fmt_gp $g_disp)%) mime=$(fmt_gms $g_mime)ms/f($(fmt_gp $g_mime)%)"
    echo "#stats:   render=$(fmt_gms $g_render)ms/f($(fmt_gp $g_render)%) hud=$(fmt_gms $g_hud)ms/f($(fmt_gp $g_hud)%) swap=$(fmt_gms $g_swap)ms/f($(fmt_gp $g_swap)%) sleep=$(fmt_gms $g_sleep)ms/f($(fmt_gp $g_sleep)%) other=$(fmt_gms $g_other)ms/f($(fmt_gp $g_other)%)"
  fi
  echo "GAME DONE"
}

main
