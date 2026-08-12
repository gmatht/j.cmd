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
VIEW_R=8                          # draw radius
RANGE=12                          # shoot range
TREASURE_TOTAL=10
MIME_CAP=12
MIME_STEP=15          # mimes step every N frames (~6.7/sec — calmer view)
MIMES_ON=0             # 0 = MIMEs disabled while diagnosing the flicker; set 1 to enable

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
  3) cr=0.10; cg=0.10; cb=0.13 ;;
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
      mime_count=$ka_last
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
    get_cell $sm_ax 0 $sm_az
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
  fi
  return 0
}

can_step() { cs_a=$1; cs_b=$2; cs=0
  if [ "$cs_a" -lt 1 ]; then return 0; fi
  if [ "$cs_a" -ge 15 ]; then return 0; fi
  if [ "$cs_b" -lt 1 ]; then return 0; fi
  if [ "$cs_b" -ge 15 ]; then return 0; fi
  get_cell $cs_a 0 $cs_b
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
hurt() { hu_d=$1; hp=$((hp - hu_d)); play "C3 0.15"; if [ "$hp" -lt 0 ]; then hp=0; fi; }

try_move() { tm_a=$1; tm_b=$2
  tm_nx=$((px + tm_a))
  tm_nz=$((pz + tm_b))
  if [ "$tm_nx" -lt 1 ]; then return 1; fi
  if [ "$tm_nx" -ge 15 ]; then return 1; fi
  if [ "$tm_nz" -lt 1 ]; then return 1; fi
  if [ "$tm_nz" -ge 15 ]; then return 1; fi
  get_cell $tm_nx 0 $tm_nz
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
  if [ "$ta_nx" -ge 15 ]; then return 1; fi
  if [ "$ta_nz" -lt 1 ]; then return 1; fi
  if [ "$ta_nz" -ge 15 ]; then return 1; fi
  get_cell $ta_nx 0 $ta_nz
  if [ "$gv" -eq "$AIR" ]; then
    start_anim $px $pz $yaw $ta_nx $ta_nz $yaw
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
    if [ "$anim_el" -gt "$ANIM_MS" ]; then anim_el=$ANIM_MS; fi
    dpcx_ms=$((ax0 * 1000 + (ax1 - ax0) * 1000 * anim_el / ANIM_MS))
    dpcz_ms=$((az0 * 1000 + (az1 - az0) * 1000 * anim_el / ANIM_MS))
    dpyw_raw_ms=$((ay0 * 90000 + anim_ayd * 90000 * anim_el / ANIM_MS))
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

# shoot straight ahead at eye level — a 1-D walk down the facing row
shoot() {
  muzzle=5
  sh_dx=${DIR_X[$yaw]}
  sh_dz=${DIR_Z[$yaw]}
  sh_i=1
  while [ "$sh_i" -le "$RANGE" ]; do
    sh_tx=$((px + sh_dx * sh_i))
    sh_tz=$((pz + sh_dz * sh_i))
    if [ "$sh_tx" -lt 1 ]; then return 1; fi
    if [ "$sh_tx" -ge 15 ]; then return 1; fi
    if [ "$sh_tz" -lt 1 ]; then return 1; fi
    if [ "$sh_tz" -ge 15 ]; then return 1; fi
    get_cell $sh_tx 0 $sh_tz
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
  hardness $dc_t
  add_bhp $dc_a 0 $dc_b
  get_bhp $dc_a 0 $dc_b
  if [ "$bh" -ge "$h" ]; then
    if [ "$dc_t" -eq "$TREASURE" ]; then
      set_cell $dc_a 0 $dc_b $AIR
      claim_treasure $dc_a $dc_b
    else
      set_cell $dc_a 0 $dc_b $AIR
      score_block $dc_t
    fi
    play "E3 0.06"
  else
    play "C3 0.05"
  fi
}

score_block() { sb_t=$1
  if [ "$sb_t" -eq "$GOLD" ]; then score=$((score + 10)); echo "  mined GOLD  +10"; fi
  if [ "$sb_t" -eq "$DIAMOND" ]; then score=$((score + 25)); echo "  mined DIAMOND  +25"; fi
  if [ "$sb_t" -eq "$RUBY" ]; then score=$((score + 50)); echo "  mined RUBY  +50"; fi
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
      set_cell $gm_x 0 $gm_z $STONE
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
      set_cell $gm_sx 0 $gm_sz $AIR
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
    set_cell $gm_cx 0 $gm_cz $AIR
    set_cell $gm_cx 1 $gm_cz $AIR
    rand 4
    if [ "$rv" -eq 0 ]; then gm_cx=$((gm_cx + 1)); fi
    if [ "$rv" -eq 1 ]; then gm_cx=$((gm_cx - 1)); fi
    if [ "$rv" -eq 2 ]; then gm_cz=$((gm_cz + 1)); fi
    if [ "$rv" -eq 3 ]; then gm_cz=$((gm_cz - 1)); fi
    if [ "$gm_cx" -lt 1 ]; then gm_cx=1; fi
    if [ "$gm_cx" -ge 15 ]; then gm_cx=14; fi
    if [ "$gm_cz" -lt 1 ]; then gm_cz=1; fi
    if [ "$gm_cz" -ge 15 ]; then gm_cz=14; fi
    gm_steps=$((gm_steps + 1))
  done
  # sprinkle coloured blocks into the y0 walls (and recolor y1 above)
  gm_placed=0
  while [ "$gm_placed" -lt 18 ]; do
    rand 14
    gm_rx=$((rv + 1))
    rand 14
    gm_rz=$((rv + 1))
    get_cell $gm_rx 0 $gm_rz
    if [ "$gv" -eq "$STONE" ]; then
      rand 3
      if [ "$rv" -eq 0 ]; then set_cell $gm_rx 0 $gm_rz $GOLD; fi
      if [ "$rv" -eq 1 ]; then set_cell $gm_rx 0 $gm_rz $DIAMOND; fi
      if [ "$rv" -eq 2 ]; then set_cell $gm_rx 0 $gm_rz $RUBY; fi
      get_cell $gm_rx 1 $gm_rz
      if [ "$gv" -eq "$STONE" ]; then
        if [ "$rv" -eq 0 ]; then set_cell $gm_rx 1 $gm_rz $GOLD; fi
        if [ "$rv" -eq 1 ]; then set_cell $gm_rx 1 $gm_rz $DIAMOND; fi
        if [ "$rv" -eq 2 ]; then set_cell $gm_rx 1 $gm_rz $RUBY; fi
      fi
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
      get_cell $pt_rx 0 $pt_rz
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
      set_cell $pt_rx 0 $pt_rz $TREASURE
      set_treasure_pos $pt_t $pt_rx $pt_rz
    fi
    pt_t=$((pt_t + 1))
  done
}

# ─── Rendering ───────────────────────────────────────────────────────
# The vertex shader is hand-written ES 1.00 (the backend only emits
# fragment shaders); the FRAGMENT shader is AUTHORED IN BASH — see
# examples/mimecroft-frag.sh — and compiled by the sh→GLSL generator
# (sh2glsl / glsl_backend.rs) at startup.
emit_fragment_shader() {
  # write the bash-authored fragment program to /tmp (single-quoted so
  # $(( ... )) stays literal), then compile it with the generator
  echo 'fx=$((frag_x))' > /tmp/mimecroft-frag.sh
  echo 'fy=$((frag_y))' >> /tmp/mimecroft-frag.sh
  echo 'r=$((vcolor_r))' >> /tmp/mimecroft-frag.sh
  echo 'g=$((vcolor_g))' >> /tmp/mimecroft-frag.sh
  echo 'b=$((vcolor_b))' >> /tmp/mimecroft-frag.sh
  echo 'scan=$((fy % 6))' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$scan" -eq 0 ]; then' >> /tmp/mimecroft-frag.sh
  echo '  r=$((r * 90 / 100))' >> /tmp/mimecroft-frag.sh
  echo '  g=$((g * 90 / 100))' >> /tmp/mimecroft-frag.sh
  echo '  b=$((b * 90 / 100))' >> /tmp/mimecroft-frag.sh
  echo 'fi' >> /tmp/mimecroft-frag.sh
  echo 'hash=$((fx * 7 + fy * 13))' >> /tmp/mimecroft-frag.sh
  echo 'corrupt=$((hash % 97))' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$corrupt" -eq 0 ]; then' >> /tmp/mimecroft-frag.sh
  echo '  r=255' >> /tmp/mimecroft-frag.sh
  echo '  g=$((g / 2))' >> /tmp/mimecroft-frag.sh
  echo '  b=$((b / 2))' >> /tmp/mimecroft-frag.sh
  echo 'fi' >> /tmp/mimecroft-frag.sh
  echo 'vx=$((fx - 120))' >> /tmp/mimecroft-frag.sh
  echo 'vy=$((fy - 90))' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$vx" -lt 0 ]; then vx=$((0 - vx)); fi' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$vy" -lt 0 ]; then vy=$((0 - vy)); fi' >> /tmp/mimecroft-frag.sh
  echo 'edge=$((vx + vy))' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$edge" -gt 150 ]; then' >> /tmp/mimecroft-frag.sh
  echo '  dim=$((edge - 150))' >> /tmp/mimecroft-frag.sh
  echo '  if [ "$dim" -gt 40 ]; then dim=40; fi' >> /tmp/mimecroft-frag.sh
  echo '  r=$((r - dim))' >> /tmp/mimecroft-frag.sh
  echo '  g=$((g - dim))' >> /tmp/mimecroft-frag.sh
  echo '  b=$((b - dim))' >> /tmp/mimecroft-frag.sh
  echo 'fi' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$r" -lt 0 ]; then r=0; fi' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$g" -lt 0 ]; then g=0; fi' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$b" -lt 0 ]; then b=0; fi' >> /tmp/mimecroft-frag.sh
  echo 'putb $r' >> /tmp/mimecroft-frag.sh
  echo 'putb $g' >> /tmp/mimecroft-frag.sh
  echo 'putb $b' >> /tmp/mimecroft-frag.sh
  echo 'putb 255' >> /tmp/mimecroft-frag.sh
  # compile it with the sh→GLSL generator; fall back to the equivalent
  # embedded shader when the generator isn't installed
  glsl=$(sh2glsl /tmp/mimecroft-frag.sh)
  if [ "$glsl" != "" ]; then
    echo "$glsl" > /dev/webgl/shader/fragment
  else
    echo "precision mediump float; varying vec4 vColor; void main() { gl_FragColor = vec4(vColor.rgb, 1.0); }" > /dev/webgl/shader/fragment
  fi
}

setup_webgl() {
  echo "attribute vec3 aPosition; attribute vec3 aShade; uniform vec3 uCamPos; uniform float uCamYaw; uniform vec3 uObjPos; uniform vec3 uBlockColor; uniform vec3 uScale; uniform float uOverlay; varying vec4 vColor; void main() { vec3 p = aPosition * uScale + uObjPos; if (uOverlay > 0.5) { gl_Position = vec4(p.x, p.y, -0.95, 1.0); vColor = vec4(aShade * uBlockColor, 1.0); return; } vec3 cam = uCamPos + vec3(0.5, 0.5, 0.5); vec3 d = p - cam; float a = uCamYaw * 0.0174532925; float c = cos(a); float s = sin(a); vec3 rel = vec3(d.x * c + d.z * s, d.y, -d.x * s + d.z * c); float z = max(-rel.z, 0.05); gl_Position = vec4(rel.x * 0.9 / z, rel.y * 0.9 / z, rel.z / 64.0, 1.0); vColor = vec4(aShade * uBlockColor, 1.0); }" > /dev/webgl/shader/vertex
  emit_fragment_shader
  echo "link" > /dev/webgl/program
  echo "f32 -0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 -0.5 0.5 -0.5 -0.5 -0.5 0.5 0.5 -0.5 0.5 0.5 -0.5 -0.5 -0.5 -0.5 -0.5 -0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 0.5 -0.5 -0.5 -0.5 0.5 -0.5 -0.5 0.5 0.5 -0.5 -0.5 0.5 -0.5 0.5 -0.5 0.5 0.5 0.5 0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 -0.5 -0.5 0.5 -0.5 0.5 0.5 -0.5 0.5 -0.5 -0.5 -0.5 -0.5" > /dev/webgl/buffer/aPosition
  echo "f32 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 0.7 1 1 1 1 1 1 1 1 1 1 1 1 0.45 0.45 0.45 0.45 0.45 0.45 0.45 0.45 0.45 0.45 0.45 0.45 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6" > /dev/webgl/buffer/aShade
  echo "u16 0 1 2 0 2 3 4 5 6 4 6 7 8 9 10 8 10 11 12 13 14 12 14 15 16 17 18 16 18 19 20 21 22 20 22 23" > /dev/webgl/buffer/cube
  echo "f32 -0.5 -0.5 0 0.5 -0.5 0 0.5 0.5 0 -0.5 0.5 0" > /dev/webgl/buffer/quadpos
  echo "f32 1 1 1 1 1 1 1 1 1 1 1 1" > /dev/webgl/buffer/quadshade
  echo "u16 0 1 2 0 2 3" > /dev/webgl/buffer/quadi
  echo "0.05 0.05 0.12 1.0" > /dev/webgl/clearcolor
}

draw_block() { db_a=$1; db_b=$2; db_c=$3; db_r=$4; db_g=$5; db_bl=$6
  echo "1 1 1" > /dev/webgl/uniform/3f/uScale
  echo "$db_a $db_b $db_c" > /dev/webgl/uniform/3f/uObjPos
  echo "$db_r $db_g $db_bl" > /dev/webgl/uniform/3f/uBlockColor
  echo "draw elements triangles 36 0 cube" > /dev/webgl/call
}

# cull + draw one cell (or a mime standing in it)
try_draw() { td_a=$1; td_b=$2; td_c=$3
  get_cell $td_a $td_b $td_c
  if [ "$gv" -eq "$AIR" ]; then
    if [ "$td_b" -eq 0 ]; then
      mime_at $td_a $td_c
      if [ "$mf" -eq 1 ]; then
        mime_color $mt
        echo "$td_a $td_b $td_c" > /dev/webgl/uniform/3f/uObjPos
        echo "0.7 0.7 0.7" > /dev/webgl/uniform/3f/uScale
        echo "$cr $cg $cb" > /dev/webgl/uniform/3f/uBlockColor
        echo "draw elements triangles 36 0 cube" > /dev/webgl/call
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
  draw_block $td_a $td_b $td_c $cr $cg $cb
  return 0
}

# painter's algorithm without sorting: iterate the grid so cells are
# drawn far-to-near along the facing axis (yaw 0→-z, 1→+x, 2→+z, 3→-x)
render_frame() {
  echo "clear" > /dev/webgl/call
  echo "0.0" > /dev/webgl/uniform/1f/uOverlay
  echo "1 1 1" > /dev/webgl/uniform/3f/uScale
  # restore the cube bindings (the overlay HUD switches them to quad)
  echo "aPosition aPosition" > /dev/webgl/bind
  echo "aShade aShade" > /dev/webgl/bind
  fmt_pos $dpcx_ms
  cxs=$fv
  fmt_pos $dpcz_ms
  czs=$fv
  fmt_pos $dpyw_ms
  yws=$fv
  echo "$cxs 0 $czs" > /dev/webgl/uniform/3f/uCamPos
  echo "$yws" > /dev/webgl/uniform/1f/uCamYaw
  # floor + ceiling planes — the maze floor is carved air, so without
  # them the near-black clear colour shows as a void below/above
  echo "8 -0.05 8" > /dev/webgl/uniform/3f/uObjPos
  echo "16 0.1 16" > /dev/webgl/uniform/3f/uScale
  echo "0.32 0.28 0.24" > /dev/webgl/uniform/3f/uBlockColor
  echo "draw elements triangles 36 0 cube" > /dev/webgl/call
  echo "8 2.05 8" > /dev/webgl/uniform/3f/uObjPos
  echo "0.15 0.15 0.18" > /dev/webgl/uniform/3f/uBlockColor
  echo "draw elements triangles 36 0 cube" > /dev/webgl/call
  echo "1 1 1" > /dev/webgl/uniform/3f/uScale
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
    rf_x=15
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
    rf_z=15
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

# the viewmodel gun — a 3D-looking rectangular shape, bottom-right at 3/4
# across, drawn back so it pokes off the bottom-right edge, tilted 20°
# counter-clockwise. R-lines are rotated quads (R cx cy w h deg r g b)
# rendered by the device; the muzzle flash appears at the barrel tip
# after a shot.
draw_gun() {
  # receiver body (partially off the bottom/right edge) + top highlight
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
  # muzzle flash — bright glow + white-hot core at the barrel tip
  if [ "$muzzle" -gt 0 ]; then
    ov_text="${ov_text}R 0.55 -0.08 0.22 0.22 20 1.0 0.82 0.2
"
    ov_text="${ov_text}R 0.55 -0.08 0.10 0.10 20 1.0 1.0 0.9
"
  fi
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

# 16×16 radar, top-right corner (air cells are left dark = background)
draw_minimap() {
  dm_x=0
  while [ "$dm_x" -lt "$MAP_W" ]; do
    dm_z=0
    while [ "$dm_z" -lt "$MAP_D" ]; do
      dm_draw=0
      if [ "$dm_x" -eq "$dpx" ] && [ "$dm_z" -eq "$dpz" ]; then
        # the player is a triangle pointing the way they face (yaw 0 = up
        # on the radar = -z, the world direction the camera starts in)
        dm_cxm=$((1260 + dm_x*44))
        dm_cym=$((1720 - dm_z*60))
        fmt_ndc $dm_cxm
        dm_cxs=$fv
        fmt_ndc $dm_cym
        dm_cys=$fv
        # display yaw (unwrapped, can be negative) so the triangle
        # glides through the SHORT arc during a turn, mirroring the view.
        # Bright yellow + slightly larger than a cell so it pops.
        dm_deg=$((0 - dpyw_raw_ms / 1000))
        ov_text="${ov_text}T $dm_cxs $dm_cys 0.042 1.0 1.0 1.0 $dm_deg
"
        dm_draw=0
      else
        mime_at $dm_x $dm_z
        if [ "$mf" -eq 1 ]; then
          dm_r=1.0; dm_g=0.35; dm_b=0.25; dm_draw=1
        else
          get_cell $dm_x 0 $dm_z
          if [ "$gv" -eq "$AIR" ]; then dm_draw=0
          elif [ "$gv" -eq "$TREASURE" ]; then dm_r=0.20; dm_g=1.00; dm_b=0.45; dm_draw=1
          else dm_r=0.42; dm_g=0.42; dm_b=0.47; dm_draw=1
          fi
        fi
      fi
      if [ "$dm_draw" -eq 1 ]; then
        dm_cxm=$((1260 + dm_x*44))
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
}

# mime type names (index 1=jpeg 2=png 3=octet-stream 4=text/plain) + lengths
MTNAME=("none" "image/jpeg" "image/png" "application/octet-stream" "text/plain")
MTN_LEN=(0 10 9 24 10)

# project a world cell to overlay NDC (milli) — the yaw rotation is exact
# integer sign/axis swaps, the perspective divide uses integer math
mime_label_pos() { ml_x=$1; ml_z=$2
  ml_dx=$((ml_x - dpx))
  ml_dz=$((ml_z - dpz))
  if [ "$dyaw" -eq 0 ]; then ml_rx=$ml_dx; ml_dp=$((0 - ml_dz)); fi
  if [ "$dyaw" -eq 1 ]; then ml_rx=$ml_dz; ml_dp=$ml_dx; fi
  if [ "$dyaw" -eq 2 ]; then ml_rx=$((0 - ml_dx)); ml_dp=$ml_dz; fi
  if [ "$dyaw" -eq 3 ]; then ml_rx=$((0 - ml_dz)); ml_dp=$((0 - ml_dx)); fi
  ml_ok=0
  if [ "$ml_dp" -gt 0 ]; then
    ml_cxm=$((1000 + ml_rx * 900 / ml_dp))
    ml_cym=$((1030 + 450 / ml_dp))
    if [ "$ml_cxm" -ge 0 ] && [ "$ml_cxm" -le 2000 ] && [ "$ml_cym" -ge 0 ] && [ "$ml_cym" -le 2000 ]; then
      ml_cx=$ml_cxm
      ml_cy=$ml_cym
      ml_ok=1
    fi
  fi
}

draw_text_centered() { dtc_cx=$1; dtc_y=$2; dtc_t=$3; dtc_len=$4; dtc_px=$5
  dtc_w=$((dtc_len * 4 * dtc_px))
  dtc_x=$((dtc_cx - dtc_w / 2))
  draw_text $dtc_t $dtc_len $dtc_x $dtc_y $dtc_px $6 $7 $8 $9
}

# the MIME type name floats above each visible MIME block
draw_mime_labels() {
  mi=0
  while [ "$mi" -lt "$mime_count" ]; do
    mla=${mx[$mi]}
    mlc=${mz[$mi]}
    mime_label_pos $mla $mlc
    if [ "$ml_ok" -eq 1 ]; then
      ml_t=${mtype[$mi]}
      mime_color $ml_t
      draw_text_centered $ml_cx $ml_cy ${MTNAME[$ml_t]} ${MTN_LEN[$ml_t]} 7 9 $cr $cg $cb
    fi
    mi=$((mi + 1))
  done
}

# sightings list under the radar: each living MIME's type, colour-coded
draw_mime_list() {
  mi=0
  ml_y=690
  while [ "$mi" -lt "$mime_count" ]; do
    ml_t=${mtype[$mi]}
    mime_color $ml_t
    fmt_ndc $((ml_y + 18))
    ml_ys=$fv
    draw_rect "0.230" $ml_ys "0.020" "0.024" $cr $cg $cb
    draw_text ${MTNAME[$ml_t]} ${MTN_LEN[$ml_t]} 1270 $ml_y 7 9 $cr $cg $cb
    ml_y=$((ml_y - 52))
    mi=$((mi + 1))
  done
}

# the whole on-canvas dashboard: score line, radar, instructions
draw_hud_canvas() {
  ov_text=""
  draw_gun
  draw_minimap
  draw_mime_labels
  draw_mime_list
  # score line (top-left)
  draw_text "SCORE" 5 60 1840 8 11 0.95 0.85 0.30
  dh_a=$((score/100%10+26))
  dh_b=$((score/10%10+26))
  dh_c=$((score%10+26))
  draw_char $dh_a 252 1840 8 11 0.95 0.85 0.30
  draw_char $dh_b 284 1840 8 11 0.95 0.85 0.30
  draw_char $dh_c 316 1840 8 11 0.95 0.85 0.30
  draw_text "HP" 2 400 1840 8 11 0.35 0.90 0.40
  dh_a=$((hp/10+26))
  dh_b=$((hp%10+26))
  draw_char $dh_a 496 1840 8 11 0.35 0.90 0.40
  draw_char $dh_b 528 1840 8 11 0.35 0.90 0.40
  draw_char 37 560 1840 8 11 0.35 0.90 0.40
  dh_a=$((maxhp/10+26))
  dh_b=$((maxhp%10+26))
  draw_char $dh_a 592 1840 8 11 0.35 0.90 0.40
  draw_char $dh_b 624 1840 8 11 0.35 0.90 0.40
  draw_text "ART" 3 760 1840 8 11 0.60 0.75 0.95
  dh_a=$((found_count/10+26))
  dh_b=$((found_count%10+26))
  draw_char $dh_a 888 1840 8 11 0.60 0.75 0.95
  draw_char $dh_b 920 1840 8 11 0.60 0.75 0.95
  draw_char 37 952 1840 8 11 0.60 0.75 0.95
  dh_a=$((TREASURE_TOTAL/10+26))
  dh_b=$((TREASURE_TOTAL%10+26))
  draw_char $dh_a 984 1840 8 11 0.60 0.75 0.95
  draw_char $dh_b 1016 1840 8 11 0.60 0.75 0.95
  # fps counter (second line, below the score — half a line lower)
  draw_text "FPS" 3 60 1778 8 11 0.55 0.95 0.95
  dh_a=$((fps/100+26))
  dh_b=$((fps/10%10+26))
  dh_c=$((fps%10+26))
  draw_char $dh_a 196 1778 8 11 0.55 0.95 0.95
  draw_char $dh_b 228 1778 8 11 0.55 0.95 0.95
  draw_char $dh_c 260 1778 8 11 0.55 0.95 0.95
  # instructions (bottom centre)
  draw_text "WASD MOVE ARROWS TURN SPACE SHOOT" 33 538 100 7 10 0.85 0.85 0.85
  echo "$ov_text" > /dev/webgl/hud
}

# print the starting maze exactly ONCE (before the game loop) — the
# dashboard then lives on the 3D canvas and the terminal stays silent
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
        get_cell $po_x 0 $po_z
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
main() {
  st=$(cat /dev/webgl/state)
  case $st in
    *headless*) sound=$((0)) ;;
    *) sound=$((1)) ;;
  esac
  setup_webgl
  gen_maze
  place_treasures
  if [ "$MIMES_ON" -eq 1 ]; then
    spawn_mime
    spawn_mime
    spawn_mime
  fi
  echo ""
  echo "╔══════════════════════════════════════════════════╗"
  echo "║  MIMEcrofT v5.4 — 3D treasure hunt written in bash ║"
  echo "║  The filesystem is infested with evil MIMEs.     ║"
  echo "║  Recover the lost operating systems.             ║"
  echo "║  WASD move · arrows turn · SPACE shoot · q quit  ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""
  print_map_once
  sleep 0.8
  frame=$((0))
  quit=$((0))
  dirty=1
  while [ "$quit" -eq 0 ] && [ "$hp" -gt 0 ] && [ "$found_count" -lt "$TREASURE_TOTAL" ]; do
    frame=$((frame + 1))
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
    # advance the camera glide by wall time; snap the discrete state
    # when the 0.2s action completes (keys unlock for the next action)
    if [ "$anim" -eq 1 ]; then
      anim_now=$(cat /dev/time)
      anim_el=$((anim_now - anim_t0))
      dirty=1
      if [ "$anim_el" -ge "$ANIM_MS" ]; then
        px=$ax1
        pz=$az1
        yaw=$ay1
        anim=0
      fi
    fi
    compute_display
    # muzzle flash lifetime: a few loop frames of flash, then force a
    # clear render so the flash doesn't linger frozen on a static scene
    if [ "$muzzle" -gt 0 ]; then
      muzzle=$((muzzle - 1))
      if [ "$muzzle" -eq 0 ]; then
        dirty=1
      fi
    fi
    mstep=$((frame % MIME_STEP))
    if [ "$MIMES_ON" -eq 1 ]; then
      if [ "$mstep" -eq 0 ]; then
        update_mimes
        dirty=1
      fi
    fi
    # Render only when the world changed (key action or mime step): a
    # complete frame — world + HUD + swap — is produced atomically, and
    # the canvas (double-buffered by the browser) keeps showing the last
    # presented frame in between. The 100fps loop stays for input
    # latency; rendering every frame at ~48ms of async dispatches would
    # cap the game at ~20fps and waste the static frames.
    if [ "$dirty" -eq 1 ]; then
      render_frame
      draw_hud_canvas
      echo "swap" > /dev/webgl/call
      dirty=0
      fps_rendered=$((fps_rendered + 1))
    else
      # keyboard heartbeat: the device releases keys 2s after the last
      # swap — a bare swap (the back buffer is unchanged) every ~1.5s
      # keeps the game's keyboard grab alive while idling
      hb=$((frame % 190))
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
        fi
        fps_rendered=0
      fi
      fps_t0=$fps_t
    fi
    sleep 0.008
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
  echo "GAME DONE"
}

main
