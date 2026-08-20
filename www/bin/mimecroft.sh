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
# y=1 wall block. Corridors are 2-tall (the drunkard's walk carves both
# y=1 and y=2); a mined passage keeps the y=2 block, so its opening is
# 1-tall and the eye ducks under it (crouch crawl). The standing eye at
# 1.6 sits above the y=1 block tops (1.5), so the corridor walls read as
# stacked blocks instead of flat planes.
#
# Renders through the /dev/webgl device (src/fs/webgldev.js) and plays
# sound through /dev/audio (audiodev.js): plain oscillator notes by
# default, or — `mimecroft --sounds bash` / the settings menu's SOUND
# MODE row — the sample-accurate examples/sounds/sound-*.sh generators
# through /dev/audio/samples. Runs in the browser via the sh2perl
# transpiler and headless in the Node CLI (NullGL device).
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
# the render/mime culling share the camera rotation (SCOS/SSIN of the
# CURRENT yaw) and the radius bound — hoisted out of try_draw (×768
# cells/render) and cell_visible (per mime step); compute_display
# refreshes rd_cs/rd_sn once per frame
rd_cs=1000
rd_sn=0
RD_VR=$((VIEW_R * 1000))
RADAR_X=80                        # radar x base (milli-NDC) — the map sits top-LEFT
# ─── settings (editable in the pre-game menu; browser only) ────────
cam_shift_ms=0        # camera right shift (milli-NDC, ±50 per press, no limit) — 0 = the centred view; the old 500 (a quarter-screen right shift) moved the vanishing point off-centre
tex_size=32           # texture resolution (1..64 px, powers of two — the
# menu ladder; 1x1 = flat colours). The MIME entity icons are always
# 64×64 (their generators clamp — the type name needs the 64 canvas;
# see lt_size_of).
tex_seed=20240812     # texture generation seed (drives the LCG noise)
# texture cache version — bump when the texture GENERATORS change (e.g.
# the mime type names) so stale session caches regenerate instead
# of uploading the old pattern
tex_ver=10         # stone noise cells are now fixed 4px/2px (jagged at every resolution)
sm_sel=0              # settings-menu cursor (0=shift 1=size 2=seed 3=crt 4=corrupt 5=mime speed 6=mime names 7=sound mode 8=minimap 9=game speed 10=vsync)
sm_done=0
sm_changed=0
headless=1            # set from /dev/webgl/state in main()
RANGE=12                          # shoot range
TREASURE_TOTAL=10
MIME_CAP=12
mime_speed=15         # mime step cadence (frames per step) — SIGNED:
                      # positive = hunt the player, negative = they RUN
                      # AWAY (cowardly MIMEs flee), 0 = frozen in place
MIMES_ON=1             # the evil MIMEs hunt you (their type name is on the texture)
MIME_LABELS=1          # 2D name banners float above each visible mime
                       # (like a player name in an MMORPG) — ON by default
                       # (toggle in the settings menu)
CRT_ON=0               # 1 = CRT scanlines + vignette on the rendered view; set 0 for a clean picture
CORRUPT_ON=0           # 1 = random corruption streaks on the view; set 0 to disable
MINIMAP_MODE=0         # the on-screen radar: 0 = off (default), 1 = full, 2 = 50% transparent
                       # (the HUD layer rects get a 0.5 alpha — the 3D view shows through)

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
# each treasure name's length (${#…} doesn't expand in this pipeline, so
# the label-texture generator reads this parallel table)
TRLEN=(8 5 7 6 7 6 5 7 12 4)

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

# ─── treasure name labels ───────────────────────────────────────────
# Each treasure gets a 64×64 RGBA texture with its OS name in the pixel
# font (GFONT), generated ONCE at startup (load_labels) and cached like
# the block textures. Every frame the visible treasures' labels are
# drawn onto the HUD layer at their projected position/size (the vertex
# shader's exact perspective), scaled to the treasure's projected size.
LABEL_TEX0=21        # /dev/webgl/texture index of the first label
LABEL_W=64           # label texture resolution (square, power of two)
LABEL_VER=3          # label-generator version (cache key)
lgi=(0 0 0 0 0 0 0 0 0 0 0 0)   # per-character glyph indices (max name 12)
tl_wpx=(0 0 0 0 0 0 0 0 0 0)   # label text pixel width  (aspect)
tl_hpx=(0 0 0 0 0 0 0 0 0 0)   # label text pixel height (aspect)
# the LAST drawn label rect per treasure (milli NDC), so the next view
# change erases it (and heals the radar underneath); -1 = not drawn
ltlx=(-1 -1 -1 -1 -1 -1 -1 -1 -1 -1)
ltly=(-1 -1 -1 -1 -1 -1 -1 -1 -1 -1)
ltlw=(0 0 0 0 0 0 0 0 0 0)
ltlh=(0 0 0 0 0 0 0 0 0 0)
labels_dirty=1       # redraw the labels when the 3D view changes
# MIME name banners (2D labels above the mime cubes). Banner textures at
# MIME_LABEL_TEX0..+3 (JPEG / PNG / OCTET-STREAM / TEXT/PLAIN), indexed
# by mime type 1..4; mbw/mbh hold each banner's text pixel size. The
# mbl* arrays hold the LAST drawn rect per mime slot (milli NDC), with
# slot MIME_CAP as the "graveyard" where kill_mime_at parks a dead
# mime's orphaned banner so the next redraw erases it.
MIME_LABEL_TEX0=31
MIME_NAMES=(dummy "JPEG" "PNG" "OCTET-STREAM" "TEXT/PLAIN")
MIME_NAMELEN=(dummy 4 3 12 10)
# Full media types for the terminal event log. Keep MIME_NAMES short for
# the 64px floating banners; the log can identify the actual MIME clearly.
MIME_TYPES=(dummy "image/jpeg" "image/png" "application/octet-stream" "text/plain")
mbw=(0 0 0 0 0)
mbh=(0 0 0 0 0)
mblx=(-1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1)
mbly=(-1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1)
mblw=(0 0 0 0 0 0 0 0 0 0 0 0 0)
mblh=(0 0 0 0 0 0 0 0 0 0 0 0 0)
# cos/sin of the view yaw (‰ of uCamYaw, 0..359°) — the labels project
# with the vertex shader's rotation so they track the 3D view exactly,
# including mid-turn glides (where the yaw is fractional)
SCOS=(1000 1000 999 999 998 996 995 993 990 988 985 982 978 974 970 966 961 956
951 946 940 934 927 921 914 906 899 891 883 875 866 857 848 839 829 819
809 799 788 777 766 755 743 731 719 707 695 682 669 656 643 629 616 602
588 574 559 545 530 515 500 485 469 454 438 423 407 391 375 358 342 326
309 292 276 259 242 225 208 191 174 156 139 122 105 87 70 52 35 17
0 -17 -35 -52 -70 -87 -105 -122 -139 -156 -174 -191 -208 -225 -242 -259 -276 -292
-309 -326 -342 -358 -375 -391 -407 -423 -438 -454 -469 -485 -500 -515 -530 -545 -559 -574
-588 -602 -616 -629 -643 -656 -669 -682 -695 -707 -719 -731 -743 -755 -766 -777 -788 -799
-809 -819 -829 -839 -848 -857 -866 -875 -883 -891 -899 -906 -914 -921 -927 -934 -940 -946
-951 -956 -961 -966 -970 -974 -978 -982 -985 -988 -990 -993 -995 -996 -998 -999 -999 -1000
-1000 -1000 -999 -999 -998 -996 -995 -993 -990 -988 -985 -982 -978 -974 -970 -966 -961 -956
-951 -946 -940 -934 -927 -921 -914 -906 -899 -891 -883 -875 -866 -857 -848 -839 -829 -819
-809 -799 -788 -777 -766 -755 -743 -731 -719 -707 -695 -682 -669 -656 -643 -629 -616 -602
-588 -574 -559 -545 -530 -515 -500 -485 -469 -454 -438 -423 -407 -391 -375 -358 -342 -326
-309 -292 -276 -259 -242 -225 -208 -191 -174 -156 -139 -122 -105 -87 -70 -52 -35 -17
0 17 35 52 70 87 105 122 139 156 174 191 208 225 242 259 276 292
309 326 342 358 375 391 407 423 438 454 469 485 500 515 530 545 559 574
588 602 616 629 643 656 669 682 695 707 719 731 743 755 766 777 788 799
809 819 829 839 848 857 866 875 883 891 899 906 914 921 927 934 940 946
951 956 961 966 970 974 978 982 985 988 990 993 995 996 998 999 999 1000)
SSIN=(0 17 35 52 70 87 105 122 139 156 174 191 208 225 242 259 276 292
309 326 342 358 375 391 407 423 438 454 469 485 500 515 530 545 559 574
588 602 616 629 643 656 669 682 695 707 719 731 743 755 766 777 788 799
809 819 829 839 848 857 866 875 883 891 899 906 914 921 927 934 940 946
951 956 961 966 970 974 978 982 985 988 990 993 995 996 998 999 999 1000
1000 1000 999 999 998 996 995 993 990 988 985 982 978 974 970 966 961 956
951 946 940 934 927 921 914 906 899 891 883 875 866 857 848 839 829 819
809 799 788 777 766 755 743 731 719 707 695 682 669 656 643 629 616 602
588 574 559 545 530 515 500 485 469 454 438 423 407 391 375 358 342 326
309 292 276 259 242 225 208 191 174 156 139 122 105 87 70 52 35 17
0 -17 -35 -52 -70 -87 -105 -122 -139 -156 -174 -191 -208 -225 -242 -259 -276 -292
-309 -326 -342 -358 -375 -391 -407 -423 -438 -454 -469 -485 -500 -515 -530 -545 -559 -574
-588 -602 -616 -629 -643 -656 -669 -682 -695 -707 -719 -731 -743 -755 -766 -777 -788 -799
-809 -819 -829 -839 -848 -857 -866 -875 -883 -891 -899 -906 -914 -921 -927 -934 -940 -946
-951 -956 -961 -966 -970 -974 -978 -982 -985 -988 -990 -993 -995 -996 -998 -999 -999 -1000
-1000 -1000 -999 -999 -998 -996 -995 -993 -990 -988 -985 -982 -978 -974 -970 -966 -961 -956
-951 -946 -940 -934 -927 -921 -914 -906 -899 -891 -883 -875 -866 -857 -848 -839 -829 -819
-809 -799 -788 -777 -766 -755 -743 -731 -719 -707 -695 -682 -669 -656 -643 -629 -616 -602
-588 -574 -559 -545 -530 -515 -500 -485 -469 -454 -438 -423 -407 -391 -375 -358 -342 -326
-309 -292 -276 -259 -242 -225 -208 -191 -174 -156 -139 -122 -105 -87 -70 -52 -35 -17)

# ─── Player / game state ────────────────────────────────────────────
px=2
pz=2
yaw=0
hp=10
maxhp=10
level=1              # the current level — MIME damage scales 1..level,
                     # and clearing a level heals 1 HP and regenerates
score=0
license=3            # your archeology licence: shooting a treasure costs
                     # one strike; three strikes revokes it (game over)
found_count=0
treasures_left=0     # TREASURE cells still on the map (a claim or a
                     # shatter decrements it) — the game ends when the
                     # board runs out of artifacts ("mined out")
treasures_placed=0   # TREASURE cells that WERE on the map at start
                     # (a short board can hold fewer than TREASURE_TOTAL)
mime_count=0
# cell → mime index lookup on the y=1 air layer (cell = z*MAP_W + x,
# -1 = empty): the render loop probes mime_at for EVERY air cell in the
# frustum — the old scan (all mimes × every air cell ≈ 3500 array reads
# per render frame) was the render's hot spot. Maintained on
# spawn/move/kill; the transpiler's loop-var array refs expand at the
# runtime boundary, so the plain writes below work.
mime_lookup=()
grass=()
ml_i=0
while [ "$ml_i" -lt "$CELLS" ]; do
  mime_lookup[$ml_i]=-1
  # grass patch flag on the walkable ground (y=1 air layer, cell =
  # z*MAP_W + x, 1 = grass): ~1/4 of the corridors get grass drawn
  # over the dirt floor — the grass texture's old treasure job
  grass[$ml_i]=0
  ml_i=$((ml_i + 1))
done
frame=0
quit=0
sound=1
demo=0
# the stats clock reference — initialized here so print_stats can run
# from ANY exit path (e.g. quitting at the settings menu, before the
# loop's g_t0=$g_now re-zeroes the window): an EMPTY g_t0 makes the
# transpiled $(( g_now - g_t0 )) skip print_stats' whole body
# (even the GAME DONE line) on that path
g_t0=0
DEMO_FRAMES=60   # `--demo`: run 60 loop frames, then quit + print the stats
SOUND_MODE=notes    # notes = /dev/audio oscillator blips (default);
                    # bash = the sample-accurate examples/sounds
                    # generators, played through /dev/audio/samples
# CLI: `mimecroft --sounds bash|notes` — the sound backend (also
# toggleable in the pre-game settings menu). `mimecroft --demo` — the
# page's auto-start demo mode: skip the settings menu, print the
# terminal map, run a short silent game loop, then quit and print the
# benchmark stats (so the demo URL always shows the full output).
if [ "$1" = "--sounds" ] || [ "$1" = "--sound" ]; then
  if [ "$2" = "bash" ]; then SOUND_MODE=bash; fi
fi
if [ "$1" = "--demo" ]; then demo=1; fi
anim=0              # 1 while an action glides the camera
precache_done=0     # the background sound pre-cache spawns once per session
anim_t0=0           # wall-clock ms when the current glide started
ANIM_MS=200         # each action completes in 0.2s of wall time
game_speed=100       # player speed as % of normal (100=normal, 10=10%, 5=5% — the settings menu's GAME SPEED item)
vsync=1              # vsync: ON = one frame per display refresh (60Hz, 16.7ms budget — the compositor clamps
                     # short sleeps, so the leftover is a REAL ≥4ms sleep and every frame paints);
                     # OFF = the legacy 100fps cap (10ms budget + the clamped minimum-yield fallback)
ANIM_MS_CROUCH=400  # a move through a 1-tall (mined) passage — half speed
anim_ms=200         # the CURRENT glide's duration (moves slow when crouched)
crouched=0          # 1 when the ceiling overhead is low — the eye ducks
an=(0 0 0 0 0 0)   # the glide state: an[0..2]=start x/z/yaw, an[3..5]=target (an ARRAY — the transpiled lift desyncs scalar anim vars; arrays stay store-consistent)
anim_ayd=0
fps=0               # rendered frames/sec (measured over ~10-frame windows)
fps_t0=0
fps_rendered=0
cfps=0              # CPU frames/sec (60 / cpu_time_for_last_60_frames)
cpu_us_acc=0        # accumulated CPU µs over the last 60 frames
cpu_frame_count=0   # frames in the current CPU measurement window
cpu_us_t0=0
cpu_us_prev=""
cpu_us_now=0
cpu_us_delta=0
muzzle=0            # muzzle-flash lifetime (loop frames remaining)
flash_done=0        # the frame the flash expires: forces one clear render
# (the retained back buffer would otherwise keep showing the last flash
# frame until the next camera move — the flash "sticks" on a static view)
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

# 3D-view invalidation: the rendered view is a pure function of the
# camera cell/yaw/crouch + the map + the mime positions. map_ver bumps
# on every cell write (mining/destruction), mimes_ver on every mime
# move/die — the loop caches the previous view and skips the full
# re-render when nothing the 3D shows changed.
map_ver=0
mimes_ver=0
prev_view_key=""

# cell access — the flat index (y*CELLS + z*MAP_W + x) is computed by
# the caller and passed as an ARG to the store helpers. `$1` arg copies
# are always runtime-store writes, so `map[$mi]` reads them back
# correctly; a plain `idx=$((…))` can be hoisted into a JS `let` the
# store-read string can't see, and `idx=$(fn …)` command substitution
# hits a broken captureSync in the shell's transpiler — arguments dodge
# both traps.
map_set() { mi=$1; mv=$2; map[$mi]=$mv; bhp[$mi]=0; map_ver=$((map_ver + 1)); }
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
  7) cr=1.00; cg=1.00; cb=1.00 ;;   # the treasure chest — white tint so the chest texture shows
  *) cr=1.00; cg=1.00; cb=1.00 ;;
esac; }

mime_color() { mc_t=$1; case $mc_t in
  1) cr=0.95; cg=0.55; cb=0.15 ;;
  2) cr=0.20; cg=0.75; cb=0.25 ;;
  3) cr=0.65; cg=0.65; cb=0.65 ;;
  4) cr=0.90; cg=0.90; cb=0.90 ;;
  *) cr=1.00; cg=0.00; cb=0.00 ;;
esac; }

# ─── sound: two backends, switched by SOUND_MODE / --sounds ───────
# notes (default): each play() call is one /dev/audio oscillator blip
# ("C3 0.05"). bash: the note call stands in for a sample-accurate
# sound from examples/sounds/sound-*.sh — the game maps it to a sound
# name, runs the generator through the REAL /bin/bash wasm once, caches
# its TSV in /tmp, then cats it to /dev/audio/samples (which decodes
# the int16 list and plays it as a buffer). Sound is off in the
# headless Node device (no Web Audio).
#
# note → sound name. Multi-note licks (the treasure fanfare, the
# shatter) are ONE bash sound — their extra notes map to "-" = skip
# (the sample already contains them). "" = no bash sound → fall back
# to the note.
snd_of_note() { sn_n=$1
  case $sn_n in
    "G5 0.08") snd="kill" ;;
    "C3 0.15") snd="damage" ;;
    "D2 0.06") snd="shoot" ;;
    "G2 0.10") snd="thud" ;;
    "E3 0.06") snd="break" ;;
    "C3 0.05") snd="hit" ;;
    "C4 0.12") snd="shatter" ;;
    "E2 0.18") snd="-" ;;
    "C5 0.10") snd="treasure" ;;
    "E5 0.10") snd="-" ;;
    "G5 0.15") snd="-" ;;
    *) snd="" ;;
  esac
}

# block id → sound-hit.sh material (stone dirt wood gold gem): mining a
# maze of different blocks *sounds* different in bash mode
block_material() { bm_t=$1
  case $bm_t in
    1) bm="dirt" ;;
    4) bm="gold" ;;
    5) bm="gem" ;;
    6) bm="gem" ;;
    *) bm="stone" ;;
  esac
}

# run one bash-generated sound. First use of a sound (or hit material)
# generates its TSV via /bin/bash and caches it in /tmp (the cache key
# is the name, so a settings change doesn't regenerate); every play
# cats the cached payload to /dev/audio/samples. sound-lib.sh is staged
# beside the generated scripts in /tmp so their $(dirname "$0")
# sources resolve through the real bash's VFS bridge.
#
# cache_sound is the SHARED generator — play_sound calls it lazily on
# first play, and precache_sounds (below) warms the SAME /tmp cache in
# the background as soon as bash sounds are enabled, so the first play
# is a cache hit instead of a ~20s generator run.
cache_sound() { cs_name=$1
  if [ "$cs_name" = "-" ] || [ "$cs_name" = "" ]; then return; fi
  if [ -f /tmp/mimecroft-snd-$cs_name.tsv ]; then return; fi
  # stage the generator: the lib is PREPENDED to the sound script with
  # its sourcing block dropped (the transpiler can't share native locals
  # across a `.` boundary yet, so the lib is inlined into ONE chunk).
  # The staged file is also valid bash, so host bash runs it identically.
  cs_base=$cs_name
  cs_mat=""
  case $cs_name in
    hit-*) cs_base="hit"; cs_mat=${cs_name#hit-} ;;
  esac
  if [ ! -f /tmp/sound-$cs_base.sh ]; then
    sl_x=$(cat /examples/sounds/sound-lib.sh)
    ss_x=$(cat /examples/sounds/sound-$cs_base.sh)
    ss_pre=${ss_x%%sl_dir=*}
    # strip through the CLOSING quote of the `. "$sl_dir/sound-lib.sh"`
    # line (the pattern includes the `"` — a separate `#\"` strip is
    # mis-transpiled in sequence)
    ss_post=${ss_x##*sound-lib.sh"}
    # the lib read strips trailing newlines — keep one between the
    # inlined lib and the script (a glued `}#!` breaks both parsers)
    echo "$sl_x
$ss_pre$ss_post" > /tmp/sound-$cs_base.sh
  fi
  if [ "$cs_mat" != "" ]; then
    cs_x=$(bash /tmp/sound-$cs_base.sh --tsv --material $cs_mat)
  else
    cs_x=$(bash /tmp/sound-$cs_base.sh --tsv)
  fi
  cs_hdr=${cs_x%%	*}
  if [ "$cs_hdr" != "#sound" ]; then return; fi
  echo "$cs_x" > /tmp/mimecroft-snd-$cs_name.tsv
}

play_sound() { ps_name=$1
  if [ "$ps_name" = "-" ] || [ "$ps_name" = "" ]; then return; fi
  cache_sound $ps_name
  if [ -f /tmp/mimecroft-snd-$ps_name.tsv ]; then
    cat /tmp/mimecroft-snd-$ps_name.tsv > /dev/audio/samples
  fi
}

# ─── background sound pre-cache ───────────────────────────────────
# As soon as bash sounds are enabled (the settings menu's SOUND MODE
# row → BASH, or `--sounds bash`), warm the /tmp sound cache in the
# background so the FIRST play of each sound is instant — the treasure
# generator is ~10K samples, ~20s of real-bash-wasm time, and the hit
# MATERIAL ladder adds five more generators. cache_sound is idempotent
# (skips existing cache files), so re-runs and mid-list plays are
# no-ops; the order puts the sounds the game plays first (the opening
# shot hits the obsidian border → thud; the first blocks mined are the
# hit materials) ahead of the long ones. treasure/shatter jump right
# after the hit materials: the FIRST claim/shatter plays the treasure
# sound then, and a COLD cache would otherwise run the ~10K-sample
# generator synchronously inside the game loop (a multi-second freeze
# that stalls every swap and lets the webgl device's 2s keyboard-
# capture window expire mid-game).
PRECACHE_N=15
PRECACHE_LIST=(hit hit-stone hit-dirt hit-wood hit-gold hit-gem treasure shatter thud break shoot walk damage kill mime)
precache_sounds() {
  pc_i=0
  while [ "$pc_i" -lt "$PRECACHE_N" ]; do
    cache_sound ${PRECACHE_LIST[$pc_i]}
    pc_i=$((pc_i + 1))
  done
}

play() { pl_note=$1; pl_mat=$2
  if [ "$sound" -eq 1 ]; then
    if [ "$SOUND_MODE" = "bash" ]; then
      snd_of_note "$pl_note"
      if [ "$snd" = "hit" ] && [ "$pl_mat" != "" ]; then
        play_sound "hit-$pl_mat"
      else
        play_sound $snd
      fi
      if [ "$snd" != "" ]; then return; fi
    fi
    echo "$pl_note" > /dev/audio/note
  fi
}

# ─── Mimes ───────────────────────────────────────────────────────────
mime_at() { ma_a=$1; ma_b=$2; mf=0; mt=0
  mli=$((ma_b * MAP_W + ma_a))
  ma_mi=${mime_lookup[$mli]}
  if [ "$ma_mi" -ge 0 ]; then mf=1; mt=${mtype[$ma_mi]}; fi
}

kill_mime_at() { ka_a=$1; ka_b=$2; ka_i=0
  mimes_ver=$((mimes_ver + 1))
  while [ "$ka_i" -lt "$mime_count" ]; do
    ka_ex=${mx[$ka_i]}
    ka_ez=${mz[$ka_i]}
    if [ "$ka_ex" -eq "$ka_a" ] && [ "$ka_ez" -eq "$ka_b" ]; then
      ka_type=${mtype[$ka_i]}
      ka_type_name=${MIME_TYPES[$ka_type]}
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
      # the dead mime's 2D banner would ghost on the HUD layer — park
      # its rect in the graveyard slot (MIME_CAP) and let the swapped
      # mime's own banner state ride along with it
      mblx[$MIME_CAP]=${mblx[$ka_i]}
      mbly[$MIME_CAP]=${mbly[$ka_i]}
      mblw[$MIME_CAP]=${mblw[$ka_i]}
      mblh[$MIME_CAP]=${mblh[$ka_i]}
      mblx[$ka_i]=${mblx[$ka_last]}
      mbly[$ka_i]=${mbly[$ka_last]}
      mblw[$ka_i]=${mblw[$ka_last]}
      mblh[$ka_i]=${mblh[$ka_last]}
      # the cell→mime lookup: the dead cell empties; if the swapped
      # mime is a DIFFERENT one, its cell now maps to the ka_i slot
      ka_cell=$((ka_b * MAP_W + ka_a))
      mime_lookup[$ka_cell]=-1
      if [ "$ka_i" -ne "$ka_last" ]; then
        ka_lx=${mx[$ka_last]}
        ka_lz=${mz[$ka_last]}
        ka_lcell=$((ka_lz * MAP_W + ka_lx))
        mime_lookup[$ka_lcell]=$ka_i
      fi
      mime_count=$ka_last
      hud_static_dirty=1
      play "G5 0.08"
      echo "  MIME sanitised: $ka_type_name  +5  ($mime_count left)"
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
    sm_cell=$((sm_az * MAP_W + sm_ax))
    mime_lookup[$sm_cell]=$mime_count
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
  cs_i=$((cs_b * MAP_W + cs_a))
  cs_m=${mime_lookup[$cs_i]}
  if [ "$cs_m" -ge 0 ]; then return 0; fi
  cs=1
  return 0
}

# is map cell (vx,vz) on screen from the CURRENT (interpolated) camera?
# The same transform as try_draw's frustum test: the cell's near face in
# front of the camera and inside the FOV cone.  Used to decide whether a
# mime move is VISIBLE — an off-screen move with the minimap off changes
# nothing on screen, so the 3D re-render (and its ~768-cell scan + GL
# dispatch) can be skipped.
cell_visible() { cv_x=$1; cv_z=$2
  cv_ddx=$(( cv_x * 1000 - dpcx_ms ))
  cv_ddz=$(( cv_z * 1000 - dpcz_ms ))
  # the rotation is the frame's shared rd_cs/rd_sn (set in
  # compute_display) — the same values try_draw uses, so a mime's
  # visibility agrees exactly with the render's frustum
  cv_cs=$rd_cs
  cv_sn=$rd_sn
  cv_w=$(( (cv_ddx * cv_sn - cv_ddz * cv_cs) / 1000 ))
  if [ "$cv_cs" -lt 0 ]; then cv_csa=$((0 - cv_cs)); else cv_csa=$cv_cs; fi
  if [ "$cv_sn" -lt 0 ]; then cv_sna=$((0 - cv_sn)); else cv_sna=$cv_sn; fi
  cv_wext=$(( 500 * (cv_csa + cv_sna) / 1000 ))
  cv_wfront=$(( cv_w + cv_wext ))
  if [ "$cv_wfront" -le 0 ]; then cv=0; return 0; fi
  cv_rx=$(( (cv_ddx * cv_cs + cv_ddz * cv_sn) / 1000 ))
  if [ "$cv_rx" -lt 0 ]; then cv_arx=$((0 - cv_rx)); else cv_arx=$cv_rx; fi
  cv_fov=$(( cv_w * 3 + 1000 ))
  if [ "$cv_arx" -gt "$cv_fov" ]; then cv=0; return 0; fi
  cv=1
}

update_mimes() {
  # any mime actually moved this step (or died reaching the player)?
  # the loop's render is gated on this — the step render otherwise
  # redraws an identical frame 6-7×/sec (the observed "FPS 7/8" idle)
  mimes_moved=0
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
    # FLEEING mimes (mime_speed < 0) swap the pairs: the away cells
    # come FIRST, the toward-player cells become the dead-end
    # backtracking — so they run from the player, and only lunge when
    # cornered (which is also the only way they can hurt you now)
    if [ "$mime_speed" -lt 0 ]; then
      um_tx=$um_p1x; um_tz=$um_p1z
      um_p1x=$um_p3x; um_p1z=$um_p3z
      um_p3x=$um_tx; um_p3z=$um_tz
      um_tx=$um_p2x; um_tz=$um_p2z
      um_p2x=$um_p4x; um_p2z=$um_p4z
      um_p4x=$um_tx; um_p4z=$um_tz
    fi
    um_moved=0
    um_n=1
    while [ "$um_n" -le 4 ] && [ "$um_moved" -eq 0 ]; do
      if [ "$um_n" -eq 1 ]; then um_cx=$um_p1x; um_cz=$um_p1z; fi
      if [ "$um_n" -eq 2 ]; then um_cx=$um_p2x; um_cz=$um_p2z; fi
      if [ "$um_n" -eq 3 ]; then um_cx=$um_p3x; um_cz=$um_p3z; fi
      if [ "$um_n" -eq 4 ]; then um_cx=$um_p4x; um_cz=$um_p4z; fi
      if [ "$um_cx" -eq "$px" ] && [ "$um_cz" -eq "$pz" ]; then
        # MIME damage is random 1..level (harder mazes, meaner bites)
        rand $level
        um_dmg=$((rv + 1))
        hurt $um_dmg
        kill_mime_at $um_a $um_b
        um_moved=1
        mimes_moved=1
      else
        can_step $um_cx $um_cz
        if [ "$cs" -eq 1 ]; then
          um_ocell=$((um_b * MAP_W + um_a))
          mime_lookup[$um_ocell]=-1
          mx[$um_i]=$um_cx
          mz[$um_i]=$um_cz
          um_ncell=$((um_cz * MAP_W + um_cx))
          mime_lookup[$um_ncell]=$um_i
          # a mime MOVING changes the 3D view too — bump the view-cache
          # version (kill_mime_at bumps it on death; without this, the
          # cached 3D view shows mimes frozen while the radar shows them
          # moving).  But only when the move is VISIBLE: the radar
          # (minimap on) shows the blip, or the cube is on screen (old
          # OR new cell — entering/leaving the view both need a render).
          # An off-screen move with the minimap off changes nothing on
          # screen, so skip the bump and the full 3D re-render it forces.
          um_vis=0
          if [ "$MINIMAP_MODE" -ne 0 ]; then um_vis=1; fi
          if [ "$um_vis" -eq 0 ]; then
            cell_visible $um_a $um_b
            if [ "$cv" -eq 1 ]; then um_vis=1; fi
          fi
          if [ "$um_vis" -eq 0 ]; then
            cell_visible $um_cx $um_cz
            if [ "$cv" -eq 1 ]; then um_vis=1; fi
          fi
          if [ "$um_vis" -eq 1 ]; then
            mimes_ver=$((mimes_ver + 1))
          fi
          um_moved=1
          mimes_moved=1
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
  # a HIDDEN treasure is claimed by WALKING into it
  if [ "$gv" -eq "$TREASURE" ]; then
    px=$tm_nx
    pz=$tm_nz
    claim_treasure $tm_nx $tm_nz
    return 0
  fi
  return 1
}

# ─── action animation: each move/turn glides the camera over ~0.5s ──
# Discrete state (px/pz/yaw) updates when the glide ENDS; render_frame
# reads the interpolated display values (dpx/dpz/dyaw + fractional milli
# positions) so the view eases instead of snapping.
start_anim() { an[0]=$1; an[1]=$2; an[2]=$3; an[3]=$4; an[4]=$5; an[5]=$6
  # the GAME SPEED setting: the glide lasts 100/game_speed × the normal
  # 0.2s, so at 10% a cell-step takes 2s and the motion is easy to study
  anim_ms=$((ANIM_MS * 100 / game_speed))
  # shortest yaw arc across the 0↔3 seam (3→0 turns +90°, not -270°)
  anim_ayd=$((an[5] - an[2]))
  if [ "$anim_ayd" -gt 2 ]; then anim_ayd=$((anim_ayd - 4)); fi
  if [ "$anim_ayd" -lt -2 ]; then anim_ayd=$((anim_ayd + 4)); fi
  # the glide clock: the sync g_now (µs). A gtick CALL here would make
  # the A1 type this body sync (the direct call) yet still emit `await`
  # — a SyntaxError; inline the clock instead
  g_now=$EPOCHREALTIME
  case $g_now in
    *.*) g_now=${g_now%.*}${g_now#*.} ;;
  esac
  anim_t0=$g_now
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
    # corridors are 2-tall, so an upright walk is the norm; a MINED
    # passage keeps its y=2 block (the 1-tall opening) — slow the glide
    # so the crouch reads as ducking under the low ceiling
    get_cell $ta_nx 2 $ta_nz
    if [ "$gv" -eq "$AIR" ]; then anim_ms=$((ANIM_MS * 100 / game_speed)); else anim_ms=$((ANIM_MS_CROUCH * 100 / game_speed)); fi
    return 0
  fi
  # a HIDDEN treasure is claimed by WALKING into it — the claim fires
  # when the glide ends (main checks the arrival cell); treasure cells
  # are always 2-tall (place_treasures guarantees it), so walk upright
  if [ "$gv" -eq "$TREASURE" ]; then
    start_anim $px $pz $yaw $ta_nx $ta_nz $yaw
    anim_ms=$((ANIM_MS * 100 / game_speed))
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
    # the glide clock is the sync µs g_now (the main loop's gtick); the
    # old anim_now=$(cat /dev/time) read was removed with the
    # sync-clock refactor, so a stale anim_now made anim_el a huge
    # NEGATIVE µs value — the interpolation ran away and dyaw landed on
    # -2/-3, which matches no culling axis, so every block culled and
    # the screen showed only the ground during moves AND turns. Compare
    # µs against anim_ms_us exactly like the loop's arrival check.
    anim_el=$((g_now - anim_t0))
    anim_ms_us=$((anim_ms * 1000))
    if [ "$anim_el" -gt "$anim_ms_us" ]; then anim_el=$anim_ms_us; fi
    dpcx_ms=$((an[0] * 1000 + (an[3] - an[0]) * 1000 * anim_el / anim_ms_us))
    dpcz_ms=$((an[1] * 1000 + (an[4] - an[1]) * 1000 * anim_el / anim_ms_us))
    dpyw_raw_ms=$((an[2] * 90000 + anim_ayd * 90000 * anim_el / anim_ms_us))
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
  # the culling rotation is camera-only — refresh the shared SCOS/SSIN
  # once per frame (try_draw's 768 cells + cell_visible both read them)
  rd_deg=$((dpyw_ms / 1000))
  rd_cs=${SCOS[$rd_deg]}
  rd_sn=${SSIN[$rd_deg]}
}

# the eye ducks (and the walk slows) when the ceiling overhead is low:
# mining breaks only the y=1 wall block, so a mined passage keeps the
# y=2 block and its 1-tall opening — the camera drops below it so it
# stops looking like you're walking INTO the ceiling. Keyed off the
# DISPLAY cell (where the eye actually is), so the duck happens as the
# eye crosses into the low cell.
crouch_hint=0           # 1 once the "Crouching, movement slowed" hint printed
update_crouch() {
  get_cell $dpx 2 $dpz
  if [ "$gv" -eq "$AIR" ]; then
    crouched=0
  else
    if [ "$crouched" -eq 0 ]; then
      # just ducked under a low ceiling — movement slows to half speed
      # (ANIM_MS_CROUCH).  Tell the player the first time it happens.
      if [ "$crouch_hint" -eq 0 ]; then
        echo "Crouching, movement slowed"
        crouch_hint=1
      fi
    fi
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
  # nothing hit within range (the row is clear / the target is beyond
  # RANGE) — the shot still makes the gun's sound; hits play their own
  # impact note (thud / tick / break / mime-kill)
  play "D2 0.06"
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
      # shooting an artifact SHATTERS it — it is NOT claimed (you must
      # WALK into a hidden treasure): -50 score and the Board takes a
      # licence strike (three strikes = licence revoked = game over)
      set_cell $dc_a 1 $dc_b $AIR
      shot_treasure $dc_a $dc_b
    else
      set_cell $dc_a 1 $dc_b $AIR
      score_block $dc_t
    fi
    # the radar's static cells changed — rebuild the base layer once
    hud_static_dirty=1
    play "E3 0.06"
  else
    # the bash-mode hit sound is MATERIAL-dependent (sound-hit.sh:
    # stone rings, dirt thumps, gold glints, gem pings)
    block_material $dc_t
    play "C3 0.05" $bm
  fi
}

score_block() { sb_t=$1
  if [ "$sb_t" -eq "$GOLD" ]; then score=$((score + 10)); digits_dirty=1; echo "  mined GOLD  +10"; fi
  if [ "$sb_t" -eq "$DIAMOND" ]; then score=$((score + 25)); digits_dirty=1; echo "  mined DIAMOND  +25"; fi
  if [ "$sb_t" -eq "$RUBY" ]; then score=$((score + 50)); digits_dirty=1; echo "  mined RUBY  +50"; fi
}

# shooting a treasure — the artifact shatters: -50 points and a licence
# strike (three strikes revoke your archeology licence = game over).
# The shattered artifact is looked up by its cell (coords arrive as
# args) so the log can name the OS you denied the world. One forgivable
# exception: macOS Darwin — RMS forgives you, so no licence strike.
shot_treasure() { st_a=$1; st_b=$2; st_t=0
  # which artifact did we just shatter? (the same tpx/tpz scan
  # claim_treasure uses to identify a claimed treasure)
  st_name=""
  while [ "$st_t" -lt "$TREASURE_TOTAL" ]; do
    st_txv=${tpx[$st_t]}
    st_tzv=${tpz[$st_t]}
    if [ "$st_txv" -eq "$st_a" ] && [ "$st_tzv" -eq "$st_b" ]; then
      st_name=${TREASURES[$st_t]}
    fi
    st_t=$((st_t + 1))
  done
  # the shattered artifact is gone from the board — the mined-out count
  # drops with it (a board with no treasures left ends the game)
  treasures_left=$((treasures_left - 1))
  score=$((score - 50))
  if [ "$score" -lt 0 ]; then score=0; fi
  # the licence strike: three strikes revoke your licence — but shooting
  # macOS Darwin is forgiven (RMS), so no strike is deducted
  st_rms=0
  if [ "$st_name" = "macOS Darwin" ]; then st_rms=1; fi
  if [ "$st_rms" -eq 0 ]; then
    license=$((license - 1))
    if [ "$license" -lt 0 ]; then license=0; fi
  fi
  digits_dirty=1
  play "C4 0.12"
  play "E2 0.18"
  echo ""
  echo "  !!! You SHOT an artifact — it shattered into dust!"
  echo "  !!! You have denied the world: $st_name"
  echo "  !!! -50 score · archeology licence $license / 3"
  if [ "$st_rms" -eq 1 ]; then
    echo "  ...but RMS forgives you."
  fi
  if [ "$license" -le 0 ]; then
    echo "  !!! LICENCE REVOKED — the game is over."
  fi
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
        treasures_left=$((treasures_left - 1))
        score=$((score + 100))
        maxhp=$((maxhp + 1))
        hp=$((hp + 1))
        digits_dirty=1
        # the recovered artifact is dug out — the block vanishes so the
        # label/radar stop showing it
        set_cell $ct_a 1 $ct_b $AIR
        hud_static_dirty=1
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
  # fill the whole maze: a dirt floor under 2-tall stone walls
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
  # clear the starting corner first (player spawns at 2,2) — the
  # drunkard walk below STARTS here, so the pocket stays connected
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
  # drunkard's walk carves the floor (and the air above it), starting
  # from the spawn cell so the maze is always reachable
  gm_cx=2
  gm_cz=2
  gm_steps=0
  gm_total=$((MAP_W * MAP_D * 55 / 100))
  while [ "$gm_steps" -lt "$gm_total" ]; do
    set_cell $gm_cx 1 $gm_cz $AIR
    set_cell $gm_cx 2 $gm_cz $AIR
    # ~1/4 of the carved ground cells get a grass patch (deterministic
    # LCG — the scatter is stable per seed)
    rand 4
    if [ "$rv" -eq 0 ]; then
      gm_gi=$((gm_cz * MAP_W + gm_cx))
      grass[$gm_gi]=1
    fi
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
  # floating gems at y=2 for depth — they cap the 2-TALL maze walls (a
  # y=1 stone wall below), so they read as bright blocks atop the walls
  # instead of floating in the corridor air (where the standing eye
  # would walk INTO them — and never over the spawn pocket)
  gm_placed=0
  while [ "$gm_placed" -lt 12 ]; do
    rand 14
    gm_rx=$((rv + 1))
    rand 14
    gm_rz=$((rv + 1))
    get_cell $gm_rx 1 $gm_rz
    if [ "$gv" -eq "$STONE" ]; then
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
        set_cell $gm_x 2 $gm_z $OBSIDIAN
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
    set_cell $gm_x 2 1 $AIR
    set_cell $gm_x 2 $gm_ci $AIR
    set_cell 1 2 $gm_x $AIR
    set_cell $gm_ci 2 $gm_x $AIR
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
        # only 2-TALL cells: the treasure must be claimable by walking
        # in (and its name label must be visible, not buried in a wall)
        get_cell $pt_rx 2 $pt_rz
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

# count the TREASURE cells still on the map — the board is mined out
# when this reaches 0 (all recovered, or shattered by shooting). The
# map is scanned AFTER place_treasures (the tests inject fixed
# placements that bypass the placement loop), then decremented on
# claim/shatter.
count_map_treasures() {
  treasures_left=0
  treasures_placed=0
  cm_x=1
  while [ "$cm_x" -lt "$BOUND_X" ]; do
    cm_z=1
    while [ "$cm_z" -lt "$BOUND_Z" ]; do
      get_cell $cm_x 1 $cm_z
      if [ "$gv" -eq "$TREASURE" ]; then
        treasures_left=$((treasures_left + 1))
        treasures_placed=$((treasures_placed + 1))
      fi
      cm_z=$((cm_z + 1))
    done
    cm_x=$((cm_x + 1))
  done
}

# ─── Rendering ───────────────────────────────────────────────────────
# BOTH shader stages are AUTHORED IN BASH — see
# www/examples/mimecroft-frag.sh (fragment) and www/examples/mimecroft-vertex.sh
# (vertex) — and compiled by the sh→GLSL generator (sh2glsl /
# glsl_backend.rs) at startup.
#
# The vertex shader is authored in bash (emit_vertex_shader compiles
# /examples/mimecroft-vertex.sh with `sh2glsl --vertex`); the FRAGMENT
# shader is authored in bash (emit_fragment_shader writes the program to
# /tmp and compiles it with `sh2glsl`). The bash-authored programs are
# the ONLY shader source — there is no hand-written fallback.
emit_vertex_shader() {
  # the vertex shader is AUTHORED IN BASH (/examples/mimecroft-vertex.sh)
  # and compiled by sh2glsl — the only source of truth. No hand-written
  # fallback: the bash path IS the shader.
  vs_src=bash
  glsl=$(sh2glsl --vertex /examples/mimecroft-vertex.sh)
  if [ "$glsl" != "" ]; then
    # the toward-player side of a same-row block is EDGE-ON: the fake
    # perspective divides by w, and the face's back half has w < 0 — its
    # triangles straddle the camera plane. The GPU's near-plane clip of
    # a straddling polygon is degenerate (the w=0 clip point fails the
    # -w≤x≤w clip volume unless x=0), so the whole face vanishes — the
    # block renders FLAT (axis-aligned edges, no visible side) and the
    # corridor walls look longer in depth than they are wide. Clamp w
    # to half a cell: a straddling vertex at w→0 would divide to ±∞ and
    # the face exploded to the window edge (the grass patches beside the
    # player looked twice as long in depth as wide). The w=0.5 floor
    # keeps every vertex in front AND bounded — the same-cell faces land
    # at the cell boundary, the corridor faces (w ≥ 0.5) are untouched.
    # (The generator's float grammar can't express the clamp, so it is
    # injected here.)
    glsl=${glsl/g_w = ((((0.0) - g_relz)) + (0.0));/g_w = ((((0.0) - g_relz)) + (0.0)); if (g_w < 0.0001) g_w = 0.0001;}
    echo "$glsl" > /dev/webgl/shader/vertex
  fi
}

emit_fragment_shader() {
  # write the bash-authored fragment program to /tmp (single-quoted so
  # $(( ... )) stays literal), then compile it with the generator
  # write the bash-authored fragment program to /tmp (single-quoted so
  # $(( ... )) stays literal), then compile it with the generator
  echo 'r=$((vcolor_r))' > /tmp/mimecroft-frag.sh
  echo 'g=$((vcolor_g))' >> /tmp/mimecroft-frag.sh
  echo 'b=$((vcolor_b))' >> /tmp/mimecroft-frag.sh
  # the gl_FragCoord bridge (fx/fy) is only read by the CRT scanline /
  # vignette and the corruption streaks — emit it ONLY when an effect
  # is enabled, so the no-effects shader skips the two per-fragment
  # int copies entirely (the option-dependent code is compiled out by
  # the generator either way — this removes the dead reads too)
  if [ "$CRT_ON" -eq 1 ] || [ "$CORRUPT_ON" -eq 1 ]; then
    echo 'fx=$((frag_x))' >> /tmp/mimecroft-frag.sh
    echo 'fy=$((frag_y))' >> /tmp/mimecroft-frag.sh
  fi
  # the block texture sampled per pixel (bridged by the generator).
  # 0..127 colour scale + /128: the tint intermediate r·tex_r ≤ 127·255
  # fits mediump int (±2^15), and 127/128 ≈ 255/255 keeps the output
  # range (max 253 ≈ 255) — the game looks identical.
  echo 'r=$((r * tex_r / 128))' >> /tmp/mimecroft-frag.sh
  echo 'g=$((g * tex_g / 128))' >> /tmp/mimecroft-frag.sh
  echo 'b=$((b * tex_b / 128))' >> /tmp/mimecroft-frag.sh
  # CRT scanline BEFORE the damage blend: the tint is r ≤ 254 here, so
  # r·90/100 stays provably inside mediump int; blending AFTER the dim
  # keeps the blend's r ≤ 228 (the (r-cr_r)·mix intermediate then fits).
  # (The scanline now dims the texture but not the crack — a 1-step
  # visual difference on damaged blocks.)
  if [ "$CRT_ON" -eq 1 ]; then
    echo 'scan=$((fy % 6))' >> /tmp/mimecroft-frag.sh
    echo 'if [ "$scan" -eq 0 ]; then' >> /tmp/mimecroft-frag.sh
    echo '  r=$((r * 90 / 100))' >> /tmp/mimecroft-frag.sh
    echo '  g=$((g * 90 / 100))' >> /tmp/mimecroft-frag.sh
    echo '  b=$((b * 90 / 100))' >> /tmp/mimecroft-frag.sh
    echo 'fi' >> /tmp/mimecroft-frag.sh
  fi
  # crack overlay: the transparent crack texture (cr_r/g/b/a bridges),
  # mixed in by the damage level (uDamage bridge) — layered over ANY
  # block texture so damaged blocks show cracks. The blend is written as
  # r - (r-cr_r)·mix/128 (≡ r·(1-mix/128) + cr_r·mix/128 — same value,
  # weights sum to 1) so the intermediate (r-cr_r)·mix ≤ 253·127 =
  # 32131 stays inside mediump int. mix = damage·cr_a (no /2) caps at
  # 127 on the FIRST hit — the crack texel takes ~99% of the blend at
  # ANY damage level, so the dark GRAY crack colour dominates from the
  # first shot and a damaged grass/gold/diamond/ruby block shows a
  # neutral crack instead of a green/olive/teal/maroon tint of the
  # block's own hue (a partial blend keeps (1-mix/128) of the block
  # colour — the damage-1 49% state still read as pure-ish coloured
  # pixels on the gems). The crack no longer scales with damage — it
  # appears fully at the first hit and the block breaks at its hardness.
  echo 'if [ "$damage" -gt 0 ]; then' >> /tmp/mimecroft-frag.sh
  echo '  mix=$((damage * cr_a))' >> /tmp/mimecroft-frag.sh
  echo '  if [ "$mix" -gt 127 ]; then mix=127; fi' >> /tmp/mimecroft-frag.sh
  echo '  r=$((r - (r - cr_r) * mix / 128))' >> /tmp/mimecroft-frag.sh
  echo '  g=$((g - (g - cr_g) * mix / 128))' >> /tmp/mimecroft-frag.sh
  echo '  b=$((b - (b - cr_b) * mix / 128))' >> /tmp/mimecroft-frag.sh
  echo 'fi' >> /tmp/mimecroft-frag.sh
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
    # multiplicative dim (r - r·dim/256): scales toward dark instead of
    # subtracting — dark pixels can never hard-clip to black. r·dim ≤
    # 255·30 fits mediump int (the /256 is a power-of-two shift).
    echo '  r=$((r - r * dim / 256))' >> /tmp/mimecroft-frag.sh
    echo '  g=$((g - g * dim / 256))' >> /tmp/mimecroft-frag.sh
    echo '  b=$((b - b * dim / 256))' >> /tmp/mimecroft-frag.sh
    echo 'fi' >> /tmp/mimecroft-frag.sh
  fi
  echo 'if [ "$r" -lt 0 ]; then r=0; fi' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$g" -lt 0 ]; then g=0; fi' >> /tmp/mimecroft-frag.sh
  echo 'if [ "$b" -lt 0 ]; then b=0; fi' >> /tmp/mimecroft-frag.sh
  echo 'putb $r' >> /tmp/mimecroft-frag.sh
  echo 'putb $g' >> /tmp/mimecroft-frag.sh
  echo 'putb $b' >> /tmp/mimecroft-frag.sh
  echo 'putb 255' >> /tmp/mimecroft-frag.sh
  # compile it with the sh→GLSL generator — the only source of truth
  fs_src=bash
  glsl=$(sh2glsl /tmp/mimecroft-frag.sh)
  if [ "$glsl" != "" ]; then
    # the generator samples both the block texture and the crack texture
    # with fract(vUv) — hoist the wrap into _uv so it's computed ONCE per
    # fragment (the crack branch reuses the same wrapped coordinate).
    glsl=${glsl/vec4 _tex = texture2D(uTex, fract(vUv));/vec2 _uv = fract(vUv);
    vec4 _tex = texture2D(uTex, _uv);}
    glsl=${glsl/texture2D(uCrack, fract(vUv));/texture2D(uCrack, _uv);}
    echo "$glsl" > /dev/webgl/shader/fragment
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
  # face brightness (aShade) — the classic directional light: the TOP
  # brightest (light from above), the bottom darkest, and the four
  # sides graded so a cube's adjacent faces differ enough to read as
  # 3D (the old near-uniform 0.85–0.95 made side blocks look flat)
  echo "f32 1 1 1 1 1 1 1 1 1 1 1 1 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.8 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6 0.6" > /dev/webgl/buffer/aShade
  echo "f32 0 0 1 0 1 1 0 1 0 0 1 0 1 1 0 1 0 0 1 0 1 1 0 1 1 1 0 1 0 0 1 0 0 1 0 0 1 0 1 1 1 1 1 0 0 0 0 1" > /dev/webgl/buffer/aUv
    echo "0" > /dev/webgl/uniform/1i/uTex
  echo "9" > /dev/webgl/uniform/1i/uCrack
  echo "0" > /dev/webgl/uniform/1i/uDamage
  fmt_pos $cam_shift_ms
    echo "$fv" > /dev/webgl/uniform/1f/uCamShift
  echo "u16 0 1 2 0 2 3 4 5 6 4 6 7 8 9 10 8 10 11 12 13 14 12 14 15 16 17 18 16 18 19 20 21 22 20 22 23" > /dev/webgl/buffer/cube
  echo "f32 -0.5 -0.5 0 0.5 -0.5 0 0.5 0.5 0 -0.5 0.5 0" > /dev/webgl/buffer/quadpos
  echo "f32 1 1 1 1 1 1 1 1 1 1 1 1" > /dev/webgl/buffer/quadshade
  echo "u16 0 1 2 0 2 3" > /dev/webgl/buffer/quadi
# ─── texture loading (background-first) ─────────────────────────────
# The generation (the slow transpiled bash run) executes on a SEPARATE
# JS thread: the menu submits each generator as a shell BACKGROUND job
# (`bash texture-x.sh --tsv … &` — the runtime's fork heuristic routes
# the nested bash exec to a worker thread, so the menu never blocks)
# and harvests each when its /tmp TSV lands. The parse + upload stays
# on the main thread (fast — a few ms). Falls back to the synchronous
# `bash` generator when a job's TSV never appears.

# parse lt_s (a generator TSV, already set by the caller) → cache +
# upload. lt_chan = fields per pixel (3 = RGB, 4 = RGBA). Shared by the
# synchronous generators and the background harvest.
#
# The transpiled shell's ${s#*TAB} prefix-strip is greedy and
# IFS-splitting is broken, so fields are consumed with the probe loop
# below (from read-texture.sh). Without these two helpers every field
# read resolves to a command-not-found, the header is never stripped,
# and the upload mangles the header ("#texture".split("x")[0] = "#te"
# — texture contains an x).
strip_tex_field() { sf_done=0
  while [ "$sf_done" -eq 0 ]; do
    sf_probe=${lt_s%%	*}
    if [ "$sf_probe" = "" ]; then sf_done=1; lt_s=${lt_s#?}; else lt_s=${lt_s#?}; fi
  done
}

read_tex_field() { f=${lt_s%%	*}
  strip_tex_field
}

load_tex_payload() { ltp_name=$1; ltp_idx=$2
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
  if [ "$lt_menu" -ne 1 ]; then
    # loading-screen geometry: 4×2 grid of 180-milli previews, 16×16 cells
    lt_basex=$(( 140 + (ltp_idx - 1) % 4 * 470 ))
    lt_basey=$(( 1600 - (ltp_idx - 1) / 4 * 470 ))
  fi
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
    if [ "$lt_chan" -eq 4 ]; then
      read_tex_field
      lt_a=$f
      lt_payload="$lt_payload $lt_a"
    fi
    # one preview rect per pixel — the texture appears as it generates
    lt_col=$(( lt_px % lt_size ))
    lt_row=$(( lt_px / lt_size ))
    lt_pxm=$(( lt_basex + lt_col * lt_cell ))
    lt_pym=$(( lt_basey - lt_row * lt_cell ))
    fmt_ndc $lt_pxm
    lt_cxs=$fv
    fmt_ndc $lt_pym
    lt_cys=$fv
    # the rect SIZE is a positive NDC width (fmt_pos), NOT a position
    # (fmt_ndc would turn 12 milli into -0.988 — a negative full-screen
    # rect, the "massive texture extension" on the loading screen)
    fmt_pos $(( lt_cell + 1 ))
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
  # session cache only (/tmp — RamFS, wiped on reload): a persistent
  # /home copy could replay a stale payload from an older generator
  echo "$lt_payload" > /tmp/mimecroft-tex-$ltp_name-$lt_ts-$tex_seed-$tex_ver
  echo "$lt_payload" > /dev/webgl/texture/$ltp_idx
  if [ "$lt_menu" -eq 1 ]; then
    # menu mode: ALSO draw the complete texture as one HUD image at the
    # side slot — the menu redraw re-emits it, so the thumbs persist
    sm_tex_thumb_line $lt_menu_slot $ltp_idx
    lt_preview="$lt_preview$tt_line
"
  fi
  # show the freshly generated texture on the loading screen (one swap
  # keeps the keyboard grab fresh, so keys typed during startup queue)
  echo "$lt_preview" > /dev/webgl/hud
  echo "swap" > /dev/webgl/call
}

# the effective texture size for a generator: the MIME entity icons
# (jpeg/png/octet/text) are always 64×64 — the generators clamp their
# own size (the type name needs the 64 canvas) — so the game's size
# bookkeeping (the generator call, the /tmp cache key and the menu's
# background harvest) must use 64 too, not the 16px block default.
# Blocks follow the menu setting.
lt_size_of() { lso_name=$1
  lso_size=$tex_size
  case $lso_name in
    jpeg|png|octet|text)
      lso_size=64
      ;;
  esac
  lt_eff=$lso_size
}

# synchronous cache replay / generation (main's load_textures and the
# menu's fallback when a background job's TSV never lands)
load_tex() { lt_name=$1; lt_idx=$2
  lt_size_of $lt_name
  lt_ts=$lt_eff
  sleep 0.01
  if [ -f /tmp/mimecroft-tex-$lt_name-$lt_ts-$tex_seed-$tex_ver ]; then
    cat /tmp/mimecroft-tex-$lt_name-$lt_ts-$tex_seed-$tex_ver > /dev/webgl/texture/$lt_idx
    if [ "$lt_menu" -eq 1 ]; then
      sm_tex_thumb_line $lt_menu_slot $lt_idx
      echo "$tt_line" > /dev/webgl/hud
    fi
    return 0
  fi
  lt_s=$(bash /examples/textures/texture-$lt_name.sh --tsv --size $lt_ts --seed $tex_seed)
  lt_chan=3
  load_tex_payload $lt_name $lt_idx
}

# RGBA variant (the transparent crack overlay — R G B A per pixel)
load_tex4() { lt_name=$1; lt_idx=$2
  lt_ts=$tex_size
  sleep 0.01
  if [ -f /tmp/mimecroft-tex-$lt_name-$tex_size-$tex_seed-$tex_ver ]; then
    cat /tmp/mimecroft-tex-$lt_name-$tex_size-$tex_seed-$tex_ver > /dev/webgl/texture/$lt_idx
    if [ "$lt_menu" -eq 1 ]; then
      sm_tex_thumb_line $lt_menu_slot $lt_idx
      echo "$tt_line" > /dev/webgl/hud
    fi
    return 0
  fi
  lt_s=$(bash /examples/textures/texture-$lt_name.sh --tsv --size $tex_size --seed $tex_seed)
  lt_chan=4
  load_tex_payload $lt_name $lt_idx
}

# ─── background generation (shell `&` fork → worker thread) ────────
tex_bg_jobs=(0 0 0 0 0 0 0 0 0 0 0 0 0 0 0)
tex_bg_n=0

# submit one texture's generation; records its job slot. The shell's
# `&` routes the nested bash exec to a worker thread (fresh runtime,
# no parent state copied), so the menu stays interactive.
tex_bg_submit() { tbn_name=$1
  # background the generation with the shell's `&` — the runtime's
  # fork heuristic routes a nested bash script exec to a WORKER THREAD
  # (fresh runtime, no parent state copied), so the menu never blocks.
  # The TSV lands in /tmp; the menu polls for it.
  lt_size_of $tbn_name
  bash /examples/textures/texture-$tbn_name.sh --tsv --size $lt_eff --seed $tex_seed > /tmp/mimecroft-bg-$tbn_name.tsv &
  tex_bg_jobs[$tex_bg_n]=$tbn_name
  tex_bg_n=$((tex_bg_n + 1))
}

# is the n-th submitted job done? (tbg=1 when its /tmp TSV landed)
tex_bg_done() { tbd_n=$1
  tbd_name=${tex_bg_jobs[$tbd_n]}
  tbd_f=/tmp/mimecroft-bg-$tbd_name.tsv
  if [ -f "$tbd_f" ]; then tbg=1; else tbg=0; fi
}

# harvest the n-th submitted texture: take the worker's TSV and
# parse/upload it (the menu slot geometry is active during the menu)
tex_bg_harvest() { tbh_n=$1; tbh_name=$2; tbh_idx=$3; tbh_chan=$4
  tbh_f=/tmp/mimecroft-bg-$tbh_name.tsv
  lt_s=$(cat "$tbh_f")
  lt_size_of $tbh_name
  lt_ts=$lt_eff
  lt_chan=$tbh_chan
  load_tex_payload $tbh_name $tbh_idx
}

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
  echo "$lt_payload" > /tmp/mimecroft-tex-$lt_name-$tex_size-$tex_seed-$tex_ver
  echo "$lt_payload" > /dev/webgl/texture/$lt_idx
  if [ "$lt_menu" -eq 1 ]; then
    sm_tex_thumb_line $lt_menu_slot $lt_idx
    echo "$tt_line" > /dev/webgl/hud
  fi
}

load_textures() {
  # the menu's background load sets lt_menu — the post-menu replay (and
  # any mid-game regen) uses the plain loading-screen geometry
  lt_menu=0
  lt_menu_slot=0
  # drain any background generations the menu submitted but didn't
  # harvest (the player started early): each harvest is fast (the
  # worker already computed the TSV), so the loading screen never
  # regenerates synchronously.
  sm_bg_i=0
  sm_bg_tries=0
  tex_bg_pending=0
  while [ "$sm_bg_i" -lt "$tex_bg_n" ]; do
    tex_bg_done $sm_bg_i
    if [ "$tbg" -eq 1 ]; then
      sm_bg_name=${sm_tex_name[$sm_bg_i]}
      if [ ! -f /tmp/mimecroft-tex-$sm_bg_name-$tex_size-$tex_seed-$tex_ver ]; then
        if [ "${sm_tex_rgba[$sm_bg_i]}" -eq 1 ]; then
          tex_bg_harvest $sm_bg_i $sm_bg_name ${sm_tex_idx[$sm_bg_i]} 4
        else
          tex_bg_harvest $sm_bg_i $sm_bg_name ${sm_tex_idx[$sm_bg_i]} 3
        fi
      fi
      sm_bg_i=$((sm_bg_i + 1))
      sm_bg_tries=0
    else
      # still generating — poll until it lands (or the worker hangs)
      tex_bg_pending=1
      sm_bg_tries=$((sm_bg_tries + 1))
      if [ "$sm_bg_tries" -gt 240 ]; then
        # ~12s: the worker is stuck — give up on the background copy
        # and let the synchronous load_tex below regenerate it
        sm_bg_i=$((sm_bg_i + 1))
        sm_bg_tries=0
      else
        sleep 0.05
      fi
    fi
  done
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
  echo "    chest…"
  load_tex chest 15
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
  # the loading-screen previews (and any late background thumbnails) sit
  # on the PERSISTENT HUD layer — the generation is fully done now, so
  # clear them: a player who quit the menu mid-generation must not see
  # the generated textures linger on the HUD. The game's first HUD
  # rebuild (hud_static_dirty) redraws the static base from scratch.
  echo "C" > /dev/webgl/hud
  hud_static_dirty=1
}

# ─── treasure-name labels ───────────────────────────────────────────
# Each treasure gets a 64×64 RGBA texture with its OS name in the pixel
# font (GFONT), generated ONCE at startup and cached like the block
# textures. The game draws these as 2D labels on the HUD layer at each
# visible treasure's projected position (draw_treasure_labels).
build_glyph_masks() {
  GMASK=(0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0)
  bg_g=0
  while [ "$bg_g" -lt 66 ]; do
    bg_m=0
    bg_k=0
    while [ "$bg_k" -lt 15 ]; do
      bg_i=$((bg_g * 15 + bg_k))
      bg_px=${GFONT[$bg_i]}
      if [ "$bg_px" -eq 1 ]; then bg_m=$((bg_m | (1 << bg_k))); fi
      bg_k=$((bg_k + 1))
    done
    GMASK[$bg_g]=$bg_m
    bg_g=$((bg_g + 1))
  done
}

# the pixel font index of each character of every label/banner name
# (glyph_index's A-Z=0..25, 0-9=26..35, space=36, '/'=37, '-'=38,
# a-z=40..65). The transpiler slices the STORE copy of a shared string
# (the lowered ${name:$i:1} read sees "") and every per-char glyph came
# back as the blank-space mask — the label loop is replaced by this
# literal table, keyed by the whole name.
label_glyphs() { lg_name=$1
  case $lg_name in
    "GNU Hurd")     lgi=(6 13 20 36 7 60 57 43) ;;
    "Linux")        lgi=(11 48 53 60 63) ;;
    "FreeBSD")      lgi=(5 57 44 44 1 18 3) ;;
    "NetBSD")       lgi=(13 44 59 1 18 3) ;;
    "OpenBSD")      lgi=(14 55 44 53 1 18 3) ;;
    "Plan 9")       lgi=(15 51 40 53 36 35) ;;
    "Minix")        lgi=(12 48 53 48 63) ;;
    "Solaris")      lgi=(18 54 51 40 57 48 58) ;;
    "macOS Darwin") lgi=(52 40 42 14 18 36 3 40 57 62 48 53) ;;
    "Unix")         lgi=(20 53 48 63) ;;
    "JPEG")         lgi=(9 15 4 6) ;;
    "PNG")          lgi=(15 13 6) ;;
    "OCTET-STREAM") lgi=(14 2 19 4 19 38 18 19 17 4 0 12) ;;
    "TEXT/PLAIN")   lgi=(19 4 23 19 37 15 11 0 8 13) ;;
    *)               lgi=(0 0 0 0 0 0 0 0 0 0 0 0) ;;
  esac
}

# render treasure $1's name into a 64×64 RGBA payload (LABEL_W) and set
# gl_payload + the text's pixel size (tl_wpx/tl_hpx — the on-screen
# label aspect mirrors the text block, so the glyphs never stretch). The
# pixel renderer is INLINE (was the shared render_label_pixels): the
# transpiler folds a shared function's gl_* geometry reads to the STORE
# (empty — the caller's writes are native locals), so every glyph mask
# read came back "" and the labels drew blank; a per-function loop keeps
# the geometry and the mask reads as consistent native locals.
gen_label_tex() { gl_t=$1
  gl_name=${TREASURES[$gl_t]}
  gl_len=${TRLEN[$gl_t]}
  # glyph scale so the text spans ~88% of the texture width (cell 4px)
  gl_gs=$(( 56 / (gl_len * 4) ))
  if [ "$gl_gs" -lt 1 ]; then gl_gs=1; fi
  gl_tw=$(( gl_len * 4 * gl_gs - 1 ))
  gl_th=$(( 5 * gl_gs + 2 ))
  tl_wpx[$gl_t]=$gl_tw
  tl_hpx[$gl_t]=$gl_th
  gl_tx0=$(( (LABEL_W - gl_tw) / 2 ))
  gl_ty0=$(( (LABEL_W - gl_th) / 2 ))
  gl_tw2=$(( gl_len * 4 * gl_gs ))
  gl_th2=$(( 5 * gl_gs ))
  label_glyphs $gl_name
  # the payload handoff stays INSIDE the generator: load_labels reads
  # gl_payload from the STORE (empty — the write here is a native local
  # after the function lowering), so the cache + device writes happen
  # here where $gl_name/$gl_payload are the native values (gl_name also
  # names the /tmp cache — a load_labels-computed name read the stale
  # native loop var and every label cached as "GNU Hurd")
  gl_idx=$((LABEL_TEX0 + gl_t))
  # render the 64×64 RGBA pixel payload (uses the gl_* geometry + lgi)
  gl_payload="$LABEL_W"
  gl_y=0
  while [ "$gl_y" -lt "$LABEL_W" ]; do
    gl_x=0
    while [ "$gl_x" -lt "$LABEL_W" ]; do
      # the semi-transparent nameplate panel behind the text
      gl_r=14; gl_g=12; gl_b=18; gl_a=120
      if [ "$gl_x" -ge $((gl_tx0 - 2)) ] && [ "$gl_x" -le $((gl_tx0 + gl_tw + 1)) ] && [ "$gl_y" -ge $((gl_ty0 - 2)) ] && [ "$gl_y" -le $((gl_ty0 + gl_th + 1)) ]; then
        gl_r=10; gl_g=9; gl_b=14; gl_a=160
      fi
      # glyph stroke + 1px outline — only inside the text block
      gl_ot=0
      gl_cx=$(( gl_x - gl_tx0 ))
      gl_cy=$(( gl_y - gl_ty0 ))
      if [ "$gl_cx" -ge 0 ] && [ "$gl_cx" -lt "$gl_tw2" ] && [ "$gl_cy" -ge 0 ] && [ "$gl_cy" -lt "$gl_th2" ]; then
        gl_ci=$(( gl_cx / (4 * gl_gs) ))
        gl_col=$(( (gl_cx - gl_ci * 4 * gl_gs) / gl_gs ))
        gl_row=$(( gl_cy / gl_gs ))
        gl_gi2=${lgi[$gl_ci]}
        gl_bit=$(( (gl_gi2 >> (gl_row * 3 + gl_col)) & 1 ))
        if [ "$gl_bit" -eq 1 ]; then gl_ot=1; fi
      fi
      if [ "$gl_ot" -eq 0 ]; then
        gl_n=0
        while [ "$gl_n" -lt 8 ] && [ "$gl_ot" -eq 0 ]; do
          gl_ox=$(( gl_cx + (gl_n % 3) - 1 ))
          gl_oy=$(( gl_cy + (gl_n / 3) - 1 ))
          if [ "$gl_ox" -ge 0 ] && [ "$gl_ox" -lt "$gl_tw2" ] && [ "$gl_oy" -ge 0 ] && [ "$gl_oy" -lt "$gl_th2" ]; then
            gl_ci2=$(( gl_ox / (4 * gl_gs) ))
            gl_col2=$(( (gl_ox - gl_ci2 * 4 * gl_gs) / gl_gs ))
            gl_row2=$(( gl_oy / gl_gs ))
            gl_gi3=${lgi[$gl_ci2]}
            gl_bit2=$(( (gl_gi3 >> (gl_row2 * 3 + gl_col2)) & 1 ))
            if [ "$gl_bit2" -eq 1 ]; then gl_ot=2; fi
          fi
          gl_n=$((gl_n + 1))
        done
      fi
      if [ "$gl_ot" -eq 1 ]; then gl_r=248; gl_g=244; gl_b=214; gl_a=255; fi
      if [ "$gl_ot" -eq 2 ]; then gl_r=8; gl_g=6; gl_b=12; gl_a=255; fi
      gl_payload="$gl_payload $gl_r $gl_g $gl_b $gl_a"
      gl_x=$((gl_x + 1))
    done
    gl_y=$((gl_y + 1))
  done
  echo "$gl_payload" > /tmp/mimecroft-label-$gl_name-64-$LABEL_VER
  echo "$gl_payload" > /dev/webgl/texture/$gl_idx
}

# ─── MIME name banners (drawn above the mime cubes) ─────────────────
# the 2D "player name" labels: one 64×64 RGBA texture per MIME type,
# same renderer as the treasure labels but with a red danger plate.
# The pixel loop is INLINE (see gen_label_tex — a shared renderer's
# gl_* geometry reads fold to the empty store and the letters blank).
gen_mime_label_tex() { gm_t=$1
  gl_name=${MIME_NAMES[$gm_t]}
  gl_len=${MIME_NAMELEN[$gm_t]}
  gl_gs=$(( 56 / (gl_len * 4) ))
  if [ "$gl_gs" -lt 1 ]; then gl_gs=1; fi
  gl_tw=$(( gl_len * 4 * gl_gs - 1 ))
  gl_th=$(( 5 * gl_gs + 2 ))
  mbw[$gm_t]=$gl_tw
  mbh[$gm_t]=$gl_th
  gl_tx0=$(( (LABEL_W - gl_tw) / 2 ))
  gl_ty0=$(( (LABEL_W - gl_th) / 2 ))
  gl_tw2=$(( gl_len * 4 * gl_gs ))
  gl_th2=$(( 5 * gl_gs ))
  label_glyphs $gl_name
  # the payload handoff stays INSIDE the generator (see gen_label_tex)
  gl_idx=$((MIME_LABEL_TEX0 + gm_t - 1))
  # render the 64×64 RGBA pixel payload (uses the gl_* geometry + lgi)
  gl_payload="$LABEL_W"
  gl_y=0
  while [ "$gl_y" -lt "$LABEL_W" ]; do
    gl_x=0
    while [ "$gl_x" -lt "$LABEL_W" ]; do
      # the semi-transparent nameplate panel behind the text
      gl_r=14; gl_g=12; gl_b=18; gl_a=120
      if [ "$gl_x" -ge $((gl_tx0 - 2)) ] && [ "$gl_x" -le $((gl_tx0 + gl_tw + 1)) ] && [ "$gl_y" -ge $((gl_ty0 - 2)) ] && [ "$gl_y" -le $((gl_ty0 + gl_th + 1)) ]; then
        gl_r=10; gl_g=9; gl_b=14; gl_a=160
      fi
      # glyph stroke + 1px outline — only inside the text block
      gl_ot=0
      gl_cx=$(( gl_x - gl_tx0 ))
      gl_cy=$(( gl_y - gl_ty0 ))
      if [ "$gl_cx" -ge 0 ] && [ "$gl_cx" -lt "$gl_tw2" ] && [ "$gl_cy" -ge 0 ] && [ "$gl_cy" -lt "$gl_th2" ]; then
        gl_ci=$(( gl_cx / (4 * gl_gs) ))
        gl_col=$(( (gl_cx - gl_ci * 4 * gl_gs) / gl_gs ))
        gl_row=$(( gl_cy / gl_gs ))
        gl_gi2=${lgi[$gl_ci]}
        gl_bit=$(( (gl_gi2 >> (gl_row * 3 + gl_col)) & 1 ))
        if [ "$gl_bit" -eq 1 ]; then gl_ot=1; fi
      fi
      if [ "$gl_ot" -eq 0 ]; then
        gl_n=0
        while [ "$gl_n" -lt 8 ] && [ "$gl_ot" -eq 0 ]; do
          gl_ox=$(( gl_cx + (gl_n % 3) - 1 ))
          gl_oy=$(( gl_cy + (gl_n / 3) - 1 ))
          if [ "$gl_ox" -ge 0 ] && [ "$gl_ox" -lt "$gl_tw2" ] && [ "$gl_oy" -ge 0 ] && [ "$gl_oy" -lt "$gl_th2" ]; then
            gl_ci2=$(( gl_ox / (4 * gl_gs) ))
            gl_col2=$(( (gl_ox - gl_ci2 * 4 * gl_gs) / gl_gs ))
            gl_row2=$(( gl_oy / gl_gs ))
            gl_gi3=${lgi[$gl_ci2]}
            gl_bit2=$(( (gl_gi3 >> (gl_row2 * 3 + gl_col2)) & 1 ))
            if [ "$gl_bit2" -eq 1 ]; then gl_ot=2; fi
          fi
          gl_n=$((gl_n + 1))
        done
      fi
      if [ "$gl_ot" -eq 1 ]; then gl_r=248; gl_g=244; gl_b=214; gl_a=255; fi
      if [ "$gl_ot" -eq 2 ]; then gl_r=8; gl_g=6; gl_b=12; gl_a=255; fi
      gl_payload="$gl_payload $gl_r $gl_g $gl_b $gl_a"
      gl_x=$((gl_x + 1))
    done
    gl_y=$((gl_y + 1))
  done
  echo "$gl_payload" > /tmp/mimecroft-mlabel-$gl_name-64-$LABEL_VER
  echo "$gl_payload" > /dev/webgl/texture/$gl_idx
}

# generate + upload the four MIME banner textures (cached like labels)
load_mime_labels() {
  ml_t=1
  while [ "$ml_t" -le 4 ]; do
    sleep 0.01
    ml_idx=$((MIME_LABEL_TEX0 + ml_t - 1))
    gen_mime_label_tex $ml_t
    echo "    ${MIME_NAMES[$ml_t]} banner…"
    ml_t=$((ml_t + 1))
  done
}


# generate + upload all ten treasure labels (cached in /tmp only —
# a fresh session regenerates, so a stale payload can never replay)
load_labels() {
  build_glyph_masks
  ll_t=0
  while [ "$ll_t" -lt "$TREASURE_TOTAL" ]; do
    sleep 0.01
    gen_label_tex $ll_t
    echo "    ${TREASURES[$ll_t]}…"
    ll_t=$((ll_t + 1))
  done
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
  elif [ "$to_t" -eq 7 ]; then tx=15
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
  # the y=0 layer is a STATIC solid dirt floor (never mined, never
  # AIR) — one textured bg plane replaces all its per-cell cubes
  if [ "$td_b" -eq 0 ]; then return 1; fi
  # get_cell inlined — the A1 fnCall dispatch is the render hot spot
  # (~768 cells × ~7 calls each per render); the map read is identical
  td_gi=$((td_b * CELLS + td_c * MAP_W + td_a))
  gv=${map[$td_gi]}
  if [ "$gv" -eq "$AIR" ]; then
    if [ "$td_b" -eq 1 ]; then
      # mime_at inlined — the cell→mime lookup (one array read)
      td_mli=$((td_c * MAP_W + td_a))
      td_mi=${mime_lookup[$td_mli]}
      if [ "$td_mi" -ge 0 ]; then
        td_mt=${mtype[$td_mi]}
        # mime_tex_of inlined (1=jpeg 2=png 3=octet 4=text)
        if [ "$td_mt" -eq 1 ]; then tx=11
        elif [ "$td_mt" -eq 2 ]; then tx=12
        elif [ "$td_mt" -eq 3 ]; then tx=13
        else tx=14; fi
        blk_p="${blk_p}$td_a $td_b $td_c 0.7 0.7 0.7 1 1 1 $tx 0
"
      fi
    fi
    return 1
  fi
  td_ddx=$((td_a * 1000 - dpcx_ms))
  td_ddz=$((td_c * 1000 - dpcz_ms))
  # abs inlined ×2 (radius: the whole 16×16 map fits VIEW_R)
  if [ "$td_ddx" -lt 0 ]; then td_adx=$((0 - td_ddx)); else td_adx=$td_ddx; fi
  if [ "$td_ddz" -lt 0 ]; then td_adz=$((0 - td_ddz)); else td_adz=$td_ddz; fi
  if [ "$td_adx" -gt "$RD_VR" ]; then return 1; fi
  if [ "$td_adz" -gt "$RD_VR" ]; then return 1; fi
  # ── continuous frustum culling ── the view rotates with the
  # interpolated dpyw_ms (the shader's uCamYaw), so the culling must
  # follow the ACTUAL camera angle: the discrete dyaw axis flips at the
  # 45° midpoint of a turn, and the new axis's frustum culled half the
  # world while the camera was only half-rotated. Same rotation as the
  # vertex shader, with the per-degree SCOS/SSIN tables (‰):
  #   rx = ddx·cs + ddz·sn   (screen-right, milli)
  #   w  = ddx·sn − ddz·cs   (depth; w > 0 = in front)
  # the per-cell SCOS/SSIN reads are hoisted to the frame's shared
  # rd_cs/rd_sn (set once in compute_display — the camera is common to
  # every cell, so 768 cells × 2 table reads became 2 scalar reads)
  td_cs=$rd_cs
  td_sn=$rd_sn
  td_w=$(( (td_ddx * td_sn - td_ddz * td_cs) / 1000 ))
  # the in-front test uses the block's NEAR face, not its centre: a unit
  # cube spans ±500 milli in world x/z, and the camera-space depth of
  # the face toward the camera is w + 500·(|cs|+|sn|)/1000. A block
  # immediately left/right of the player has centre w = 0 (on the camera
  # plane) but its front face is half a cell IN FRONT — the projection
  # draws it (the near edge lands on screen, NDC |x| < 1), so culling on
  # the centre made the corridor walls beside the player vanish whenever
  # the camera sat exactly on the cell row. (The cone test below keeps
  # the centre-w: for a same-row cell it admits |rx| ≤ 1 cell, exactly
  # the on-screen near-face edge, and still culls cells 2+ to the side.)
  if [ "$td_cs" -lt 0 ]; then td_csa=$((0 - td_cs)); else td_csa=$td_cs; fi
  if [ "$td_sn" -lt 0 ]; then td_sna=$((0 - td_sn)); else td_sna=$td_sn; fi
  td_wext=$(( 500 * (td_csa + td_sna) / 1000 ))
  td_wfront=$(( td_w + td_wext ))
  if [ "$td_wfront" -le 0 ]; then return 1; fi
  td_rx=$(( (td_ddx * td_cs + td_ddz * td_sn) / 1000 ))
  if [ "$td_rx" -lt 0 ]; then td_arx=$((0 - td_rx)); else td_arx=$td_rx; fi
  # the cone keeps |rx| ≤ w + w/2 + 1 cell (the old axis-FOV shape,
  # at any angle) — at axis-aligned yaws this reduces exactly to the
  # old radius / in-front / in-row tests
  td_fov=$(( td_w * 3 + 1000 ))
  if [ "$td_arx" -gt "$td_fov" ]; then return 1; fi
  # block_color inlined
  if [ "$gv" -eq 1 ]; then cr=0.55; cg=0.35; cb=0.20
  elif [ "$gv" -eq 2 ]; then cr=0.55; cg=0.55; cb=0.58
  elif [ "$gv" -eq 3 ]; then cr=0.55; cg=0.50; cb=0.70
  elif [ "$gv" -eq 4 ]; then cr=0.95; cg=0.75; cb=0.10
  elif [ "$gv" -eq 5 ]; then cr=0.20; cg=0.85; cb=0.85
  elif [ "$gv" -eq 6 ]; then cr=0.85; cg=0.15; cb=0.20
  elif [ "$gv" -eq 7 ]; then cr=1.00; cg=1.00; cb=1.00
  else cr=1.00; cg=1.00; cb=1.00; fi
  # texture_of inlined
  if [ "$gv" -eq 2 ]; then tx=1
  elif [ "$gv" -eq 3 ]; then tx=10
  elif [ "$gv" -eq 4 ]; then tx=2
  elif [ "$gv" -eq 5 ]; then tx=3
  elif [ "$gv" -eq 6 ]; then tx=4
  elif [ "$gv" -eq 7 ]; then tx=15
  else tx=0; fi
  # draw_block inlined (get_bhp + the batched append) — same cell index
  # as the map read above (td_gi)
  bh=${bhp[$td_gi]}
  blk_p="${blk_p}$td_a $td_b $td_c 1 1 1 $cr $cg $cb $tx $bh
"
  return 0
}

# painter's algorithm without sorting: iterate the grid so cells are
# drawn far-to-near along the facing axis (yaw 0→-z, 1→+x, 2→+z, 3→-x)
render_frame() {
  # scene/gl split: the whole render_frame (g_rf) is the CPU floor/planes
  # + 768-cell cull + grass payload build (g_scene, timed below) plus the
  # GL writes (the clear/binds at the top + the batched depthmask/blocks
  # at the bottom) — gl-render = g_rf − g_scene.
  gtick
  r_rf0=$g_now
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
  # the eye height: standing 1.6 (the shader adds 0.5 to uCamPos.y, so
  # cys 1.100 → the eye at 1.6 — ABOVE the y=1 block tops (1.5), so the
  # lower wall layer's top faces are visible and the corridor walls read
  # as stacked 3D blocks instead of flat planes); crouched 0.75 → the eye
  # ducks under the 1.5 ceiling of a mined 1-tall opening. The two
  # heights are constants (250/1100 milli) — fmt_pos is hoisted to the
  # literal strings
  if [ "$crouched" -eq 1 ]; then cys=0.250; else cys=1.100; fi
  echo "$cxs $cys $czs" > /dev/webgl/uniform/3f/uCamPos
  echo "$yws" > /dev/webgl/uniform/1f/uCamYaw
  # floor + ceiling planes — the background. They span the whole maze
  # and cross the camera, so their clipped depths are garbage; draw
  # them FIRST with depth WRITES OFF (gl.depthMask 0) — they fill the
  # void but never occlude the cubes, which paint over them.
  # camera-following patches (span 40 = ±20 cells) so the coverage is
  # ROTATION-INVARIANT — a fixed 16-wide slab ended at the map edge, so
  # mid-turn the plane's boundary swept across the view and the clear
  # colour (blackness) showed past the obsidian border.
  # The FLOOR plane IS the ground: the whole y=0 dirt layer in ONE quad
  # (the per-cell y=0 cubes are skipped in try_draw). It sits at the
  # wall-base level (top 0.5 = the old y=0 cube tops) with the DIRT
  # texture repeating once per world unit — the vertex shader's
  # world-xz UV branch (usc_x > 1100) tiles it, so 256 cubes/frame
  # become one textured draw.
  # The FLOOR/CEILING are FOUR quadrant boxes each (20 wide, centred
  # ±10 on the camera) instead of ONE 40x40 box around it: a single
  # box's top face has the camera INSIDE its footprint, so its triangles
  # straddle the camera plane (w<0 vertices) and the GPU's polygon
  # clipping collapses the near ground to a sliver ("near ground shows
  # briefly while rotating"). A quadrant box's triangles are uniformly
  # in front or behind after the yaw rotation, so every fragment clips
  # cleanly. The boxes MEET at the camera's axes (±10 centres, 20 wide
  # → spans [0,20] / [-20,0]) — the w=0 corners at the camera plane are
  # off-screen below, so there is no seam between the quadrants.
  gtick
  r_sc0=$g_now
  bg_p=""
  qp0=$(( dpx * 1000 ))
  qpz0=$(( dpz * 1000 ))
  for qd in 1 2 3 4; do
    if [ "$qd" -eq 1 ]; then qdx=10000; qdz=10000; fi
    if [ "$qd" -eq 2 ]; then qdx=10000; qdz=-10000; fi
    if [ "$qd" -eq 3 ]; then qdx=-10000; qdz=10000; fi
    if [ "$qd" -eq 4 ]; then qdx=-10000; qdz=-10000; fi
    qpx=$(( qp0 + qdx ))
    qpz=$(( qpz0 + qdz ))
    fmt_pos $qpx
    qfx=$fv
    fmt_pos $qpz
    qfz=$fv
    bg_p="${bg_p}$qfx 0.45 $qfz 20 0.1 20 1 1 1 8 0
"
    bg_p="${bg_p}$qfx 2.05 $qfz 20 0.1 20 0.24 0.24 0.28 0 0
"
  done
  if [ "$dyaw" -eq 0 ]; then
    # facing -z: front = z < dpz, so FAR = smallest z — draw z
    # ascending so the far "outside" cubes hit the canvas first and
    # the near destructible walls paint over them
    rf_z=0
    while [ "$rf_z" -lt "$MAP_D" ]; do
      rf_x=0
      while [ "$rf_x" -lt "$MAP_W" ]; do
        try_draw $rf_x 0 $rf_z
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
        try_draw $rf_x 0 $rf_z
        try_draw $rf_x 1 $rf_z
        try_draw $rf_x 2 $rf_z
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
        try_draw $rf_x 0 $rf_z
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
        try_draw $rf_x 0 $rf_z
        try_draw $rf_x 1 $rf_z
        try_draw $rf_x 2 $rf_z
        rf_z=$((rf_z + 1))
      done
      rf_x=$((rf_x + 1))
    done
  fi
  # background planes first with depth WRITES OFF (gl.depthMask 0) —
  # they fill the void but never record depth, so the cubes drawn after
  # (depth writes on) ALWAYS paint over them
  # grass patches on the marked walkable cells: thin quads at the
  # floor (top face at 0.525, just above the dirt plane's 0.5). The
  # depth test sorts them under the walls (written earlier) and over
  # the floor plane (which draws with depth writes OFF).
  gs_i=0
  while [ "$gs_i" -lt "$CELLS" ]; do
    # array reads go to a scalar FIRST (the game's discipline — an
    # arr[$i] read inside a test bracket doesn't transpile)
    gs_v=${grass[$gs_i]}
    if [ "$gs_v" -eq 1 ]; then
      gs_x=$((gs_i % MAP_W))
      gs_z=$((gs_i / MAP_W))
      blk_p="${blk_p}$gs_x 0.5 $gs_z 1 0.05 1 1 1 1 5 0
"
    fi
    gs_i=$((gs_i + 1))
  done
  gtick
  g_scene=$(( g_scene + g_now - r_sc0 ))
  echo "0" > /dev/webgl/depthmask
  echo "$bg_p" > /dev/webgl/blocks
  echo "1" > /dev/webgl/depthmask
  echo "$blk_p" > /dev/webgl/blocks
  gtick
  g_rf=$(( g_rf + g_now - r_rf0 ))
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

# format a 0-255 colour channel to a 0.00-1.00 NDC component (the
# texture payloads carry raw ints; the device needs the float form).
# Lost in the same edit that dropped read_tex_field/strip_tex_field —
# without it every per-pixel fmt_c call resolved to a command-not-found
# (the shell even tried /www/wasm-bin/fmt_c.wasm).
fmt_c() { fc_v=$1
  fc_x=$(( (fc_v * 100) / 255 ))
  if [ "$fc_x" -ge 100 ]; then fv="1.00"
  elif [ "$fc_x" -lt 10 ]; then fv="0.0$fc_x"
  else fv="0.$fc_x"; fi
}

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
  if [ "$8" = "" ]; then
    ov_text="${ov_text}$dr_cx $dr_cy $dr_w $dr_h $5 $6 $7
"
  else
    ov_text="${ov_text}$dr_cx $dr_cy $dr_w $dr_h $5 $6 $7 $8
"
  fi
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
GFONT=(1 1 1 1 0 1 1 1 1 1 0 1 1 0 1 1 1 0 1 0 1 1 1 0 1 0 1 1 1 0 1 1 1 1 0 0 1 0 0 1 0 0 1 1 1 1 1 0 1 0 1 1 0 1 1 0 1 1 1 0 1 1 1 1 0 0 1 1 0 1 0 0 1 1 1 1 1 1 1 0 0 1 1 0 1 0 0 1 0 0 1 1 1 1 0 0 1 1 1 1 0 1 1 1 1 1 0 1 1 0 1 1 1 1 1 0 1 1 0 1 1 1 1 0 1 0 0 1 0 0 1 0 1 1 1 0 0 1 0 0 1 0 0 1 1 0 1 1 1 1 1 0 1 1 1 0 1 0 0 1 1 0 1 0 1 1 0 0 1 0 0 1 0 0 1 0 0 1 1 1 1 0 1 1 1 1 1 1 1 1 0 1 1 0 1 1 0 1 1 1 1 1 0 1 1 0 1 1 0 1 1 1 1 1 0 1 1 0 1 1 0 1 1 1 1 1 1 0 1 0 1 1 1 0 1 0 0 1 0 0 1 1 1 1 0 1 1 0 1 1 1 0 1 1 1 1 1 0 1 0 1 1 1 0 1 0 1 1 0 1 1 1 1 1 0 0 1 1 1 0 0 1 1 1 1 1 1 1 0 1 0 0 1 0 0 1 0 0 1 0 1 0 1 1 0 1 1 0 1 1 0 1 1 1 1 1 0 1 1 0 1 1 0 1 1 0 1 0 1 0 1 0 1 1 0 1 1 1 1 1 1 1 1 0 1 1 0 1 1 0 1 0 1 0 1 0 1 1 0 1 1 0 1 1 0 1 0 1 0 0 1 0 0 1 0 1 1 1 0 0 1 0 1 0 1 0 0 1 1 1 1 1 1 1 0 1 1 0 1 1 0 1 1 1 1 0 1 0 1 1 0 0 1 0 0 1 0 1 1 1 1 1 1 0 0 1 1 1 1 1 0 0 1 1 1 1 1 1 0 0 1 1 1 1 0 0 1 1 1 1 1 0 1 1 0 1 1 1 1 0 0 1 0 0 1 1 1 1 1 0 0 1 1 1 0 0 1 1 1 1 1 1 1 1 0 0 1 1 1 1 0 1 1 1 1 1 1 1 0 0 1 0 1 0 0 1 0 0 1 0 1 1 1 1 0 1 1 1 1 1 0 1 1 1 1 1 1 1 1 0 1 1 1 1 0 0 1 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 1 0 1 0 1 0 0 1 0 0 0 0 0 0 0 0 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 1 1 0 1 1 0 1 1 1 1 1 0 0 1 0 0 1 1 0 1 0 1 1 1 0 0 0 0 1 1 1 1 0 0 1 0 0 1 1 1 0 0 1 0 0 1 1 0 1 1 0 1 1 1 1 0 0 0 1 1 1 1 0 1 1 1 0 1 1 1 0 0 1 0 1 1 0 1 0 0 1 0 0 1 0 0 0 0 1 1 1 1 0 1 1 1 1 0 0 1 1 0 0 1 0 0 1 1 0 1 0 1 1 0 1 0 1 0 0 0 0 0 1 0 0 1 0 0 1 0 0 0 1 0 0 0 0 0 1 0 0 1 1 1 1 1 0 0 1 0 1 1 1 0 1 0 1 1 0 1 1 0 0 1 0 0 1 0 0 1 0 0 0 1 1 0 0 0 1 0 1 1 1 1 1 1 1 1 0 1 0 0 0 1 1 0 1 0 1 1 0 1 1 0 1 0 0 0 1 1 1 1 0 1 1 0 1 1 1 1 0 0 0 1 1 0 1 0 1 1 1 0 1 0 0 0 0 0 1 0 1 1 0 1 1 1 1 0 0 1 0 0 0 0 0 0 1 1 0 1 0 1 1 0 0 0 0 0 1 1 1 1 0 0 0 0 1 1 1 1 0 1 0 0 1 0 1 1 1 0 1 0 0 0 1 0 0 0 0 0 0 1 0 1 1 0 1 1 1 1 0 0 0 0 0 0 1 0 1 1 0 1 0 1 0 0 0 0 0 0 0 1 0 1 1 1 1 1 1 1 0 0 0 0 0 0 1 0 1 0 1 0 1 0 1 0 0 0 1 0 1 1 0 1 1 1 1 0 0 1 0 0 0 0 0 0 1 1 1 0 1 0 1 1 1 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0)

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
    :) gi=66 ;;
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
# the radar's alpha: 1.0 normally, 0.5 in the 50%-transparent mode
# (the HUD-layer rects get an optional 8th field the device rasterizes
# as rgba — the 3D view shows through the radar at half strength).
radar_a=1.0
if [ "$MINIMAP_MODE" -eq 2 ]; then radar_a=0.5; fi
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
  draw_rect $rc_cxs $rc_cys $CELL_W $CELL_H $rc_r $rc_g $rc_b $radar_a
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
  # blip must fit the radar cell box (44×60 milli): ring 36×48,
  # core 24×32 — the old 75×100/50×70 overflowed into neighbour cells
  draw_rect $mb_cxs $mb_cys 0.036 0.048 0.10 0.10 0.12 $radar_a
  draw_rect $mb_cxs $mb_cys 0.024 0.032 $cr $cg $cb $radar_a
}

draw_minimap() {
  if [ "$MINIMAP_MODE" -eq 0 ]; then return 0; fi
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
        # rotating: the triangle's widest sweep is ~47 milli (its 42
        # milli bbox grows to √1.25×42 mid-glide), so erase a 62×60 box
        # — at least 2 px (5 milli) beyond it left/right and 1 px
        # (3.3 milli) above/below, so no ghost pixels survive a turn
        # (the old 132-wide row wiped the whole LEFT/RIGHT neighbour
        # cells) — then restore the base cells (walls/treasures) and
        # any mimes the box grazed
        erase_rect $((RADAR_X + prev_px*44)) $((1720 - prev_pz*60)) 62 60
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
        # a move (angle unchanged): the triangle is 42×42 — erase a 44
        # box (the cell width), no longer clearing into the neighbour
        # cells left/right like the old 64 box did
        erase_rect $((RADAR_X + prev_px*44)) $((1720 - prev_pz*60)) 44 44
      fi
    fi
    prev_px=$dpx
    prev_pz=$dpz
    prev_deg=$dm_deg
  fi
  # the player square must be clear BEFORE each turn animation frame:
  # the rotating triangle leaves ghost pixels when the cell it is about
  # to be drawn in still carries the previous frame's orientation (the
  # state-change erase above targets the PREVIOUS cell, which can differ
  # from the display cell the triangle is drawn at). Erase the current
  # square + restore its base/mimes, then draw the triangle.
  if [ "$anim" -eq 1 ]; then
    erase_rect $((RADAR_X + dpx*44)) $((1720 - dpz*60)) 62 60
    draw_radar_cell $((dpx - 1)) $dpz
    draw_radar_cell $dpx $dpz
    draw_radar_cell $((dpx + 1)) $dpz
    dm_bi=0
    while [ "$dm_bi" -lt "$mime_count" ]; do
      dm_mx=${mx[$dm_bi]}
      dm_mz=${mz[$dm_bi]}
      if [ "$dm_mz" -eq "$dpz" ]; then
        if [ "$dm_mx" -eq "$dpx" ] || [ "$dm_mx" -eq "$((dpx - 1))" ] || [ "$dm_mx" -eq "$((dpx + 1))" ]; then
          draw_mime_blip $dm_bi
        fi
      fi
      dm_bi=$((dm_bi + 1))
    done
  fi
  dm_cxm=$((RADAR_X + dpx*44))
  dm_cym=$((1720 - dpz*60))
  fmt_ndc $dm_cxm
  dm_cxs=$fv
  fmt_ndc $dm_cym
  dm_cys=$fv
  ov_text="${ov_text}T $dm_cxs $dm_cys 0.042 1.0 1.0 1.0 $dm_deg $radar_a
"
  # mimes — bright red blips (ring + coloured core); only MOVED cells
  # are erased and redrawn (they step every |mime_speed| frames)
  mi=0
  while [ "$mi" -lt "$mime_count" ]; do
    dm_mx=${mx[$mi]}
    dm_mz=${mz[$mi]}
    dm_rmx=${rmx[$mi]}
    dm_rmz=${rmz[$mi]}
    if [ "$dm_rmx" -ne "$dm_mx" ] || [ "$dm_rmz" -ne "$dm_mz" ]; then
      if [ "$dm_rmx" -ge 0 ]; then
        # erase just the blip's cell (40×52 covers the 36×48 ring without
        # punching into the neighbouring cells' static base)
        erase_rect $((RADAR_X + dm_rmx*44)) $((1720 - dm_rmz*60)) 40 52
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
prev_score=""       # previous values for conditional erase+redraw
prev_hp=""
prev_art=""
prev_fps=""
prev_lic=""
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
  # digit grid: 32px per digit (8px×4), y=1840 — all positions computed once
  d_W=32
  d_Y=1840
  # score
  d_score_x=60;  d_score_dx=252
  # HP
  d_hp_x=400;  d_hp_dx=496;  d_hp_sx=$((d_hp_dx+2*d_W))
  # ART
  d_art_x=680;  d_art_dx=808;  d_art_sx=$((d_art_dx+2*d_W))
  # FPS labels and digit start positions (space = d_W/2 after each label)
  d_fps_x=$((d_art_dx+4*d_W+2*d_W))
  d_w_x=$((d_fps_x+4*d_W+d_W/2))
  d_w_dx=$((d_w_x+d_W/2+d_W/2))
  d_slash_x=$((d_w_dx+3*d_W+d_W/2))
  d_c_x=$((d_slash_x+d_W+d_W/2))
  d_c_dx=$((d_c_x+d_W/2+d_W/2))
  d_lic_x=$((d_c_dx+3*d_W+2*d_W+d_W/2))
  d_lic_dx=$((d_lic_x+3*d_W+d_W/2))
  # draw static labels
  draw_text "SCORE" 5 $d_score_x $d_Y 8 11 0.95 0.85 0.30
  draw_text "HP" 2 $d_hp_x $d_Y 8 11 0.35 0.90 0.40
  draw_char 37 $d_hp_sx $d_Y 8 11 0.35 0.90 0.40
  draw_text "ART" 3 $d_art_x $d_Y 8 11 0.60 0.75 0.95
  draw_char 37 $d_art_sx $d_Y 8 11 0.60 0.75 0.95
  draw_text "FPS:" 4 $d_fps_x $d_Y 8 11 0.70 0.70 0.70
  draw_text "W" 1 $d_w_x $d_Y 8 11 0.55 0.95 0.95
  draw_text "/" 1 $d_slash_x $d_Y 8 11 0.70 0.70 0.70
  draw_text "C" 1 $d_c_x $d_Y 8 11 0.45 0.85 0.85
  draw_text "LIC" 3 $d_lic_x $d_Y 8 11 0.95 0.60 0.30
  # instructions (bottom centre)
  draw_text "WASD MOVE ARROWS TURN SPACE SHOOT" 33 538 100 7 10 0.85 0.85 0.85
  # radar base: walls + treasure cells (air stays dark; the player and
  # MIMEs are air cells, drawn dynamically over this base each frame).
  # The whole base is skipped when the minimap is OFF; the 50% mode
  # draws it at half alpha.
  radar_a=1.0
  if [ "$MINIMAP_MODE" -eq 2 ]; then radar_a=0.5; fi
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
        if [ "$MINIMAP_MODE" -ne 0 ]; then
          dm_cxm=$((RADAR_X + dm_x*44))
          dm_cym=$((1720 - dm_z*60))
          fmt_ndc $dm_cxm
          dm_cxs=$fv
          fmt_ndc $dm_cym
          dm_cys=$fv
          draw_rect $dm_cxs $dm_cys $CELL_W $CELL_H $dm_r $dm_g $dm_b $radar_a
        fi
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
  # reuse d_W, d_Y and d_*_dx positions computed in hud_build_static
  # track previous values — only erase+redraw groups that changed
  # score digits (3 digits, no slash)
  dh_val=$((score))
  if [ "$dh_val" != "$prev_score" ]; then
    erase_rect $d_score_dx $((d_Y-24)) $((d_W*3)) 62
    dh_a=$((dh_val/100%10+26))
    dh_b=$((dh_val/10%10+26))
    dh_c=$((dh_val%10+26))
    draw_char $dh_a $d_score_dx $d_Y 8 11 0.95 0.85 0.30
    draw_char $dh_b $((d_score_dx+d_W)) $d_Y 8 11 0.95 0.85 0.30
    draw_char $dh_c $((d_score_dx+2*d_W)) $d_Y 8 11 0.95 0.85 0.30
    prev_score=$dh_val
  fi
  # HP digits (current / max, slash between)
  dh_val=$((hp*1000+maxhp))
  if [ "$dh_val" != "$prev_hp" ]; then
    erase_rect $d_hp_dx $((d_Y-24)) $((d_W*5)) 62
    dh_a=$((hp/10+26))
    dh_b=$((hp%10+26))
    draw_char $dh_a $d_hp_dx $d_Y 8 11 0.35 0.90 0.40
    draw_char $dh_b $((d_hp_dx+d_W)) $d_Y 8 11 0.35 0.90 0.40
    draw_char 37 $d_hp_sx $d_Y 8 11 0.35 0.90 0.40
    dh_a=$((maxhp/10+26))
    dh_b=$((maxhp%10+26))
    draw_char $dh_a $((d_hp_sx+d_W)) $d_Y 8 11 0.35 0.90 0.40
    draw_char $dh_b $((d_hp_sx+2*d_W)) $d_Y 8 11 0.35 0.90 0.40
    prev_hp=$dh_val
  fi
  # ART digits (found / total, slash between)
  dh_val=$((found_count*1000+TREASURE_TOTAL))
  if [ "$dh_val" != "$prev_art" ]; then
    erase_rect $d_art_dx $((d_Y-24)) $((d_W*5)) 62
    dh_a=$((found_count/10+26))
    dh_b=$((found_count%10+26))
    draw_char $dh_a $d_art_dx $d_Y 8 11 0.60 0.75 0.95
    draw_char $dh_b $((d_art_dx+d_W)) $d_Y 8 11 0.60 0.75 0.95
    draw_char 37 $d_art_sx $d_Y 8 11 0.60 0.75 0.95
    dh_a=$((TREASURE_TOTAL/10+26))
    dh_b=$((TREASURE_TOTAL%10+26))
    draw_char $dh_a $((d_art_sx+d_W)) $d_Y 8 11 0.60 0.75 0.95
    draw_char $dh_b $((d_art_sx+2*d_W)) $d_Y 8 11 0.60 0.75 0.95
    prev_art=$dh_val
  fi
  # fps digits: Wnnn/Cnnn — wall-clock first, then CPU, bright white
  dh_val=$((fps*10000+cfps))
  if [ "$dh_val" != "$prev_fps" ]; then
    erase_rect $d_w_dx $((d_Y-24)) $((d_W*7)) 62
    dh_a=$((fps/100+26))
    dh_b=$((fps/10%10+26))
    dh_c=$((fps%10+26))
    draw_char $dh_a $d_w_dx $d_Y 8 11 0.95 0.95 0.95
    draw_char $dh_b $((d_w_dx+d_W)) $d_Y 8 11 0.95 0.95 0.95
    draw_char $dh_c $((d_w_dx+2*d_W)) $d_Y 8 11 0.95 0.95 0.95
    dh_a=$((cfps/100+26))
    dh_b=$((cfps/10%10+26))
    dh_c=$((cfps%10+26))
    draw_char $dh_a $d_c_dx $d_Y 8 11 0.95 0.95 0.95
    draw_char $dh_b $((d_c_dx+d_W)) $d_Y 8 11 0.95 0.95 0.95
    draw_char $dh_c $((d_c_dx+2*d_W)) $d_Y 8 11 0.95 0.95 0.95
    prev_fps=$dh_val
  fi
  # licence digit (right of LIC label — strikes remaining)
  dh_val=$((license))
  if [ "$dh_val" != "$prev_lic" ]; then
    erase_rect $d_lic_dx $((d_Y-24)) $d_W 62
    draw_char $((dh_val+26)) $d_lic_dx $d_Y 8 11 0.95 0.60 0.30
    prev_lic=$dh_val
  fi
}

# ─── treasure name labels ───────────────────────────────────────────
# is treasure $1's label visible in the current view? Same frustum
# culling as the block renderer (radius / in-front / in-row), plus a
# line-of-sight check on the ray from the eye to the treasure: the
# standing eye (1.6) sees OVER the 1.5-tall y=1 walls, so only y=2
# blocks occlude; crouched (eye 0.75) the y=1 walls occlude too.
# is a 2D banner at world cell (bv_x, bv_z) visible? — the block
# renderer's frustum culling (radius / in-front / in-row) plus a
# line-of-sight check on the ray from the eye to the cell: the standing
# eye (1.6) sees OVER the 1.5-tall y=1 walls, so only y=2 blocks
# occlude; crouched (eye 0.75) the y=1 walls occlude too.
banner_visible() { bv_x=$1; bv_z=$2
  bv=0
  bv_ddx=$((bv_x - dpx))
  bv_ddz=$((bv_z - dpz))
  abs $bv_ddx
  bv_adx=$av
  abs $bv_ddz
  bv_adz=$av
  if [ "$bv_adx" -gt "$VIEW_R" ]; then return 0; fi
  if [ "$bv_adz" -gt "$VIEW_R" ]; then return 0; fi
  # same continuous frustum as try_draw: the discrete dyaw axis flips
  # at the 45° midpoint of a turn and would pop the banner a half-turn
  # early — cull with the interpolated dpyw_ms instead
  bv_ddx_ms=$((bv_x * 1000 - dpcx_ms))
  bv_ddz_ms=$((bv_z * 1000 - dpcz_ms))
  bv_deg=$((dpyw_ms / 1000))
  bv_cs=${SCOS[$bv_deg]}
  bv_sn=${SSIN[$bv_deg]}
  bv_w=$(( (bv_ddx_ms * bv_sn - bv_ddz_ms * bv_cs) / 1000 ))
  if [ "$bv_w" -le 0 ]; then return 0; fi
  bv_rx=$(( (bv_ddx_ms * bv_cs + bv_ddz_ms * bv_sn) / 1000 ))
  if [ "$bv_rx" -lt 0 ]; then bv_arx=$((0 - bv_rx)); else bv_arx=$bv_rx; fi
  bv_fov=$(( bv_w * 3 + 1000 ))
  if [ "$bv_arx" -gt "$bv_fov" ]; then return 0; fi
  # line of sight: step the ray toward the cell (dominant axis)
  bv_n=$bv_adx
  if [ "$bv_adz" -gt "$bv_n" ]; then bv_n=$bv_adz; fi
  bv_k=1
  while [ "$bv_k" -lt "$bv_n" ]; do
    bv_ix=$(( dpx + bv_ddx * bv_k / bv_n ))
    bv_iz=$(( dpz + bv_ddz * bv_k / bv_n ))
    if [ "$bv_ix" -ne "$dpx" ] || [ "$bv_iz" -ne "$dpz" ]; then
      get_cell $bv_ix 2 $bv_iz
      if [ "$gv" -ne "$AIR" ]; then return 0; fi
      if [ "$crouched" -eq 1 ]; then
        get_cell $bv_ix 1 $bv_iz
        if [ "$gv" -ne "$AIR" ]; then return 0; fi
      fi
    fi
    bv_k=$((bv_k + 1))
  done
  bv=1
  return 0
}

# treasure label visibility: the cell must still hold the treasure
treasure_label_visible() { tv_t=$1
  tlv=0
  tv_x=${tpx[$tv_t]}
  tv_z=${tpz[$tv_t]}
  get_cell $tv_x 1 $tv_z
  if [ "$gv" -ne "$TREASURE" ]; then return 0; fi
  banner_visible $tv_x $tv_z
  tlv=$bv
  return 0
}

# project treasure $1's label onto the screen — the vertex shader's
# exact perspective (uCamYaw rotation via SCOS/SSIN, 0.45 focal scale,
# uCamShift screen shift). Outputs pndc_x_ms/pndc_y_ms (centre) and
# pndc_w_ms/pndc_h_ms (size), all milli-NDC; pndc_x_ms = -1 = hidden.
# project a 2D banner centred over world cell (pb_x, pb_z) — the
# vertex shader's exact perspective (uCamYaw rotation via SCOS/SSIN,
# 0.45 focal scale, uCamShift screen shift). pb_wpx×pb_hpx = the label
# texture's text pixel size (keeps the glyph aspect undistorted),
# pb_lw = the banner's world width (milli). Outputs pndc_x_ms/pndc_y_ms
# (centre) and pndc_w_ms/pndc_h_ms (size), all milli-NDC; pndc_x_ms =
# -1 = hidden.
project_banner() { pb_x=$1; pb_z=$2; pb_wpx=$3; pb_hpx=$4; pb_lw=$5
  pndc_x_ms=-1
  pj_dx=$(( pb_x * 1000 - dpcx_ms ))
  pj_dz=$(( pb_z * 1000 - dpcz_ms ))
  if [ "$crouched" -eq 1 ]; then pj_eye=750; else pj_eye=1600; fi
  pj_dy=$(( 1650 - pj_eye ))
  pj_deg=$(( dpyw_ms / 1000 ))
  pj_c=${SCOS[$pj_deg]}
  pj_s=${SSIN[$pj_deg]}
  pj_rx=$(( (pj_dx * pj_c + pj_dz * pj_s) / 1000 ))
  pj_rz=$(( (pj_dz * pj_c - pj_dx * pj_s) / 1000 ))
  pj_w=$(( 0 - pj_rz ))
  if [ "$pj_w" -lt 200 ]; then return 1; fi
  pndc_x_ms=$(( pj_rx * 450 / (pj_w * 1000) + cam_shift_ms ))
  pndc_y_ms=$(( pj_dy * 450 / (pj_w * 1000) ))
  pndc_w_ms=$(( 450 * pb_lw / (pj_w * 1000) ))
  pj_lh=$(( pb_lw * pb_hpx / pb_wpx ))
  pndc_h_ms=$(( 450 * pj_lh / (pj_w * 1000) ))
  if [ "$pndc_w_ms" -lt 4 ]; then pndc_w_ms=4; fi
  if [ "$pndc_h_ms" -lt 4 ]; then pndc_h_ms=4; fi
  if [ "$pndc_x_ms" -lt 0 ]; then pndc_x_ms=0; fi
  if [ "$pndc_x_ms" -gt 2000 ]; then pndc_x_ms=2000; fi
  if [ "$pndc_y_ms" -lt 0 ]; then pndc_y_ms=0; fi
  if [ "$pndc_y_ms" -gt 2000 ]; then pndc_y_ms=2000; fi
  return 0
}

# the treasure label projection — 1.4× the block's width, floating above
project_label() { pj_t=$1
  pj_x=${tpx[$pj_t]}
  pj_z=${tpz[$pj_t]}
  pj_hpx=${tl_hpx[$pj_t]}
  pj_wpx=${tl_wpx[$pj_t]}
  project_banner $pj_x $pj_z $pj_wpx $pj_hpx 1400
}

# a label erase punches a hole through the persistent HUD layer, which
# also contains the static radar base — redraw the radar cells (and any
# mime blips) under a milli-NDC rect so no ghosts remain
restore_under() { ru_cx=$1; ru_cy=$2; ru_w=$3; ru_h=$4
  ru_rx=$(( ru_cx - ru_w / 2 - 30 ))
  ru_rx2=$(( ru_cx + ru_w / 2 + 30 ))
  ru_ry=$(( ru_cy - ru_h / 2 - 30 ))
  ru_ry2=$(( ru_cy + ru_h / 2 + 30 ))
  ru_gx=$(( (ru_rx - RADAR_X) / 44 ))
  if [ "$ru_gx" -lt 0 ]; then ru_gx=0; fi
  ru_gx2=$(( (ru_rx2 - RADAR_X) / 44 ))
  if [ "$ru_gx2" -ge "$MAP_W" ]; then ru_gx2=$((MAP_W - 1)); fi
  while [ "$ru_gx" -le "$ru_gx2" ]; do
    ru_gz=$(( (1720 - ru_ry2) / 60 ))
    if [ "$ru_gz" -lt 0 ]; then ru_gz=0; fi
    ru_gz2=$(( (1720 - ru_ry) / 60 ))
    if [ "$ru_gz2" -ge "$MAP_D" ]; then ru_gz2=$((MAP_D - 1)); fi
    while [ "$ru_gz" -le "$ru_gz2" ]; do
      draw_radar_cell $ru_gx $ru_gz
      ru_gz=$((ru_gz + 1))
    done
    ru_gx=$((ru_gx + 1))
  done
  ru_m=0
  while [ "$ru_m" -lt "$mime_count" ]; do
    ru_mx=${mx[$ru_m]}
    ru_mz=${mz[$ru_m]}
    ru_mcx=$(( RADAR_X + ru_mx * 44 ))
    ru_mcy=$(( 1720 - ru_mz * 60 ))
    if [ "$ru_mcx" -ge "$ru_rx" ] && [ "$ru_mcx" -le "$ru_rx2" ] && [ "$ru_mcy" -ge "$ru_ry" ] && [ "$ru_mcy" -le "$ru_ry2" ]; then
      draw_mime_blip $ru_m
    fi
    ru_m=$((ru_m + 1))
  done
}

# draw every visible treasure's name label on the HUD layer: erase the
# previous frame's labels first (healing the radar), then project and
# draw the current ones. Runs only when the 3D view changed
# (labels_dirty — the layer is persistent otherwise).
draw_treasure_labels() {
  dtl_t=0
  while [ "$dtl_t" -lt "$TREASURE_TOTAL" ]; do
    dtl_px=${ltlx[$dtl_t]}
    if [ "$dtl_px" -ge 0 ]; then
      erase_rect ${ltlx[$dtl_t]} ${ltly[$dtl_t]} ${ltlw[$dtl_t]} ${ltlh[$dtl_t]}
      restore_under ${ltlx[$dtl_t]} ${ltly[$dtl_t]} ${ltlw[$dtl_t]} ${ltlh[$dtl_t]}
      ltlx[$dtl_t]=-1
    fi
    treasure_label_visible $dtl_t
    if [ "$tlv" -eq 1 ]; then
      project_label $dtl_t
      if [ "$pndc_x_ms" -ge 0 ]; then
        fmt_ndc $pndc_x_ms
        dtl_cx=$fv
        fmt_ndc $pndc_y_ms
        dtl_cy=$fv
        fmt_pos $pndc_w_ms
        dtl_w=$fv
        fmt_pos $pndc_h_ms
        dtl_h=$fv
        dtl_idx=$((LABEL_TEX0 + dtl_t))
        ov_text="${ov_text}I $dtl_cx $dtl_cy $dtl_w $dtl_h $dtl_idx
"
        ltlx[$dtl_t]=$pndc_x_ms
        ltly[$dtl_t]=$pndc_y_ms
        ltlw[$dtl_t]=$pndc_w_ms
        ltlh[$dtl_t]=$pndc_h_ms
      fi
    fi
    dtl_t=$((dtl_t + 1))
  done
}

# draw the MIME name banners above every visible mime (the "player
# name" look): erase the previous frame's banners first (healing the
# radar), then project + draw the current ones. Runs with the treasure
# labels on each view change (labels_dirty); the graveyard slot's
# orphaned rect (a dead mime's banner) is erased first. MIME_LABELS=0
# erases everything and draws nothing.
draw_mime_labels() {
  # erase any banner orphaned by a mime death (kill_mime_at parks it)
  if [ "${mblx[$MIME_CAP]}" -ge 0 ]; then
    erase_rect ${mblx[$MIME_CAP]} ${mbly[$MIME_CAP]} ${mblw[$MIME_CAP]} ${mblh[$MIME_CAP]}
    restore_under ${mblx[$MIME_CAP]} ${mbly[$MIME_CAP]} ${mblw[$MIME_CAP]} ${mblh[$MIME_CAP]}
    mblx[$MIME_CAP]=-1
  fi
  dml_i=0
  while [ "$dml_i" -lt "$mime_count" ]; do
    dml_px=${mblx[$dml_i]}
    if [ "$dml_px" -ge 0 ]; then
      erase_rect ${mblx[$dml_i]} ${mbly[$dml_i]} ${mblw[$dml_i]} ${mblh[$dml_i]}
      restore_under ${mblx[$dml_i]} ${mbly[$dml_i]} ${mblw[$dml_i]} ${mblh[$dml_i]}
      mblx[$dml_i]=-1
    fi
    if [ "$MIME_LABELS" -eq 1 ]; then
      dml_x=${mx[$dml_i]}
      dml_z=${mz[$dml_i]}
      banner_visible $dml_x $dml_z
      if [ "$bv" -eq 1 ]; then
        dml_t=${mtype[$dml_i]}
        dml_wpx=${mbw[$dml_t]}
        dml_hpx=${mbh[$dml_t]}
        project_banner $dml_x $dml_z $dml_wpx $dml_hpx 1000
        if [ "$pndc_x_ms" -ge 0 ]; then
          fmt_ndc $pndc_x_ms
          dml_cx=$fv
          fmt_ndc $pndc_y_ms
          dml_cy=$fv
          fmt_pos $pndc_w_ms
          dml_w=$fv
          fmt_pos $pndc_h_ms
          dml_h=$fv
          dml_idx=$((MIME_LABEL_TEX0 + dml_t - 1))
          ov_text="${ov_text}I $dml_cx $dml_cy $dml_w $dml_h $dml_idx
"
          mblx[$dml_i]=$pndc_x_ms
          mbly[$dml_i]=$pndc_y_ms
          mblw[$dml_i]=$pndc_w_ms
          mblh[$dml_i]=$pndc_h_ms
        fi
      fi
    fi
    dml_i=$((dml_i + 1))
  done
}

draw_hud_canvas() {
  if [ "$hud_static_dirty" -eq 1 ]; then
    # hudb = the one-time static rebuild (radar base + labels + the
    # instructions) — the previous gspan ended at the render, so this
    # first gspan parks the pre-build tail in hudb too; the second
    # parks the build itself. The main loop's later gspan "hud" then
    # measures only the per-frame part (minimap + digits + labels +
    # the layer write).
    gspan "hudb"
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
    # the rebuild's C-wipe cleared the labels too — redraw them
    labels_dirty=1
    gspan "hudb"
  fi
  ov_text=""
  draw_minimap
  # the muzzle flash is a TRANSIENT ON-TOP overlay (/dev/webgl/hud/flash
  # — drawn over the persistent HUD at swap, cleared every swap): it is
  # written ONLY while muzzle > 0, so when the flash expires the game
  # simply stops writing it and it vanishes — no erase, no gun redraw.
  # (The old flash_clear erase+redraw cycle is gone: the gun in the
  # static layer is never overlapped by a persistent flash.)
  if [ "$muzzle" -gt 0 ]; then
    echo "R 0.55 -0.08 0.22 0.22 20 1.0 0.82 0.2
R 0.55 -0.08 0.10 0.10 20 1.0 1.0 0.9" > /dev/webgl/hud/flash
  fi
  if [ "$digits_dirty" -eq 1 ]; then
    draw_digits
    digits_dirty=0
  fi
  if [ "$labels_dirty" -eq 1 ]; then
    draw_treasure_labels
    draw_mime_labels
    labels_dirty=0
  fi
  if [ "$ov_text" != "" ]; then
    echo "$ov_text" > /dev/webgl/hud
  fi
}

print_map_once() {
  # This is called exactly once per game invocation, after start_level.
  # Do not use a persistent /tmp sentinel: it suppresses the map on every
  # later run in the same shell/session, making a healthy game look silent.
  echo ""
  echo "MIMEcroft  artifacts $found_count/$TREASURE_TOTAL  hp $hp/$maxhp  score $score  mimes $mime_count  licence $license"
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
  # the transpiled shell returns Date.now()*1000 (integer µs, no dot) —
  # only host bash / the real-bash wasm carry the "secs.micros" form
  case $g_now in
    *.*) g_now=${g_now%.*}${g_now#*.} ;;
  esac
  if [ "$g_now" = "" ]; then
    g_now=$(date +%s%N 2>/dev/null)
    if [ "$g_now" != "" ]; then g_now=$(( g_now / 1000 )); fi
  fi
  if [ "$g_now" = "" ]; then g_now=0; fi
}

# per-phase accumulators (µs) — what holds the frame rate back, by how
gtick_cpu() {
  cpu_us_now=$EPOCHCPUTIME
  if [ "$cpu_us_prev" = "" ]; then cpu_us_prev=$cpu_us_now; fi
  cpu_us_delta=$((cpu_us_now - cpu_us_prev))
  if [ "$cpu_us_delta" -lt 0 ]; then cpu_us_delta=0; fi
  cpu_us_prev=$cpu_us_now
}
# much: input / anim / display / mimes / render (whole phase) / hudb
# (static HUD rebuild) / hud (per-frame HUD draw) / swap / sleepa
# (pacing sleep during an action glide) / sleepi (idle pacing). The
# targeted packs (gtick deltas, not gspans) split render's internals:
# g_scene = the CPU floor/ceiling + 768-cell cull + grass payload build,
# g_rf = the whole render_frame (scene + the GL writes), so
# gl-render = g_rf − g_scene. g_setup = start_level (maze gen + treasures
# + the static/base) wherever it runs (initial level + transitions).
g_in=0
g_anim=0
g_disp=0
g_mime=0
g_render=0
g_hudb=0
g_hud=0
g_swap=0
g_sleep=0
g_sleepa=0
g_sleepi=0
g_scene=0
g_rf=0
g_setup=0

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
  if [ "$gs_name" = "hudb" ]; then g_hudb=$(( g_hudb + gs_d )); fi
  if [ "$gs_name" = "hud" ]; then g_hud=$(( g_hud + gs_d )); fi
  if [ "$gs_name" = "swap" ]; then g_swap=$(( g_swap + gs_d )); fi
  if [ "$gs_name" = "sleepa" ]; then g_sleepa=$(( g_sleepa + gs_d )); fi
  if [ "$gs_name" = "sleepi" ]; then g_sleepi=$(( g_sleepi + gs_d )); fi
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
    if [ "$tex_size" -eq 1 ]; then tex_size=2
    elif [ "$tex_size" -eq 2 ]; then tex_size=4
    elif [ "$tex_size" -eq 4 ]; then tex_size=8
    elif [ "$tex_size" -eq 8 ]; then tex_size=16
    elif [ "$tex_size" -eq 16 ]; then tex_size=32
    elif [ "$tex_size" -eq 32 ]; then tex_size=64
    else tex_size=1
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
  if [ "$sm_sel" -eq 5 ]; then
    # speed ladder: |n| = frames per step (lower = faster), sign =
    # direction (positive = hunt, negative = flee, 0 = frozen). The
    # RIGHT arrow / d INCREASES the value — the same direction as the
    # other menu items (camera shift, texture size, seed, toggles):
    # 30 (slowest hunt) → 1 (fastest hunt) → 0 (frozen) → −1..−30
    # (fleeing, faster). Wrap: 30 → −30.
    if [ "$mime_speed" -eq -30 ]; then mime_speed=-15
    elif [ "$mime_speed" -eq -15 ]; then mime_speed=-10
    elif [ "$mime_speed" -eq -10 ]; then mime_speed=-6
    elif [ "$mime_speed" -eq -6 ]; then mime_speed=-4
    elif [ "$mime_speed" -eq -4 ]; then mime_speed=-2
    elif [ "$mime_speed" -eq -2 ]; then mime_speed=-1
    elif [ "$mime_speed" -eq -1 ]; then mime_speed=0
    elif [ "$mime_speed" -eq 0 ]; then mime_speed=1
    elif [ "$mime_speed" -eq 1 ]; then mime_speed=2
    elif [ "$mime_speed" -eq 2 ]; then mime_speed=4
    elif [ "$mime_speed" -eq 4 ]; then mime_speed=6
    elif [ "$mime_speed" -eq 6 ]; then mime_speed=10
    elif [ "$mime_speed" -eq 10 ]; then mime_speed=15
    elif [ "$mime_speed" -eq 15 ]; then mime_speed=30
    else mime_speed=-30
    fi
  fi
  if [ "$sm_sel" -eq 6 ]; then
    MIME_LABELS=1
  fi
  if [ "$sm_sel" -eq 7 ]; then
    SOUND_MODE=bash
    # warm the sound cache right away — the user wants the first play
    # instant, not after the menu closes (main's check already passed)
    if [ "$precache_done" -eq 0 ]; then
      precache_done=1
      precache_sounds &
    fi
  fi
  if [ "$sm_sel" -eq 8 ]; then
    # minimap: OFF -> ON -> 50% -> OFF (the right arrow increases)
    if [ "$MINIMAP_MODE" -eq 0 ]; then MINIMAP_MODE=1
    elif [ "$MINIMAP_MODE" -eq 1 ]; then MINIMAP_MODE=2
    else MINIMAP_MODE=0
    fi
  fi
  if [ "$sm_sel" -eq 9 ]; then
    # game speed ladder: 100 → 50 → 20 → 10 → 5 → 2 → 1 → back to 100
    # (the right arrow increases — 100 = normal, lower = slower)
    if [ "$game_speed" -eq 100 ]; then game_speed=50
    elif [ "$game_speed" -eq 50 ]; then game_speed=20
    elif [ "$game_speed" -eq 20 ]; then game_speed=10
    elif [ "$game_speed" -eq 10 ]; then game_speed=5
    elif [ "$game_speed" -eq 5 ]; then game_speed=2
    elif [ "$game_speed" -eq 2 ]; then game_speed=1
    else game_speed=100
    fi
  fi
  if [ "$sm_sel" -eq 10 ]; then
    # vsync (the right arrow increases → ON): the frame budget is read
    # every frame, so the toggle takes effect immediately
    vsync=1
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
    elif [ "$tex_size" -eq 4 ]; then tex_size=2
    elif [ "$tex_size" -eq 2 ]; then tex_size=1
    else tex_size=64
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
  if [ "$sm_sel" -eq 5 ]; then
    # the ladder, reversed: the LEFT arrow / a DECREASES the value
    # (−30 fastest flee → −1 slowest flee → 0 frozen → 1 fastest hunt
    # → 30 slowest hunt). Wrap: −30 → 30.
    if [ "$mime_speed" -eq 30 ]; then mime_speed=15
    elif [ "$mime_speed" -eq 15 ]; then mime_speed=10
    elif [ "$mime_speed" -eq 10 ]; then mime_speed=6
    elif [ "$mime_speed" -eq 6 ]; then mime_speed=4
    elif [ "$mime_speed" -eq 4 ]; then mime_speed=2
    elif [ "$mime_speed" -eq 2 ]; then mime_speed=1
    elif [ "$mime_speed" -eq 1 ]; then mime_speed=0
    elif [ "$mime_speed" -eq 0 ]; then mime_speed=-1
    elif [ "$mime_speed" -eq -1 ]; then mime_speed=-2
    elif [ "$mime_speed" -eq -2 ]; then mime_speed=-4
    elif [ "$mime_speed" -eq -4 ]; then mime_speed=-6
    elif [ "$mime_speed" -eq -6 ]; then mime_speed=-10
    elif [ "$mime_speed" -eq -10 ]; then mime_speed=-15
    elif [ "$mime_speed" -eq -15 ]; then mime_speed=-30
    else mime_speed=30
    fi
  fi
  if [ "$sm_sel" -eq 6 ]; then
    MIME_LABELS=0
  fi
  if [ "$sm_sel" -eq 7 ]; then
    SOUND_MODE=notes
  fi
  if [ "$sm_sel" -eq 8 ]; then
    # minimap: OFF <- 50% <- ON <- OFF (the left arrow decreases)
    if [ "$MINIMAP_MODE" -eq 2 ]; then MINIMAP_MODE=1
    elif [ "$MINIMAP_MODE" -eq 1 ]; then MINIMAP_MODE=0
    else MINIMAP_MODE=2
    fi
  fi
  if [ "$sm_sel" -eq 9 ]; then
    # game speed ladder (the left arrow decreases — lower = slower)
    if [ "$game_speed" -eq 1 ]; then game_speed=2
    elif [ "$game_speed" -eq 2 ]; then game_speed=5
    elif [ "$game_speed" -eq 5 ]; then game_speed=10
    elif [ "$game_speed" -eq 10 ]; then game_speed=20
    elif [ "$game_speed" -eq 20 ]; then game_speed=50
    elif [ "$game_speed" -eq 50 ]; then game_speed=100
    else game_speed=1
    fi
  fi
  if [ "$sm_sel" -eq 10 ]; then
    vsync=0
  fi
}

# ─── background texture loading (menu screen) ──────────────────────
# While the settings menu is up, the block textures load ONE per menu
# loop iteration (the loop's sleep yields between) and their previews
# materialize along the MENU'S SIDES: slot n → row n/2, left column
# (n even) at x≈170 or right column (n odd) at x≈1830. The load_tex
# calls write /tmp cache files, so main's load_textures after the menu
# replays every texture instantly (cache hits).
sm_tex_total=15
sm_tex_name=(stone sandstone water brick grass leaves wood dirt obsidian chest jpeg png octet text crack)
sm_tex_idx=(1 2 3 4 5 6 7 8 10 15 11 12 13 14 9)
sm_tex_rgba=(0 0 0 0 0 0 0 0 0 0 0 0 0 0 1)
sm_tex_n=0

# pick the side slot for the n-th texture and set the load_tex preview
# geometry to it (the per-pixel rect grid materializes there)
sm_tex_slot() { ts_n=$1
  lt_menu=1
  lt_menu_slot=$ts_n
  ts_col=$(( ts_n % 2 ))
  ts_row=$(( ts_n / 2 ))
  if [ "$ts_col" -eq 0 ]; then lt_basex=170; else lt_basex=1830; fi
  lt_basey=$(( 1700 - ts_row * 140 ))
}

# the thumb line for the n-th slot: ONE HUD image (I cx cy w h tex —
# the complete texture, alpha blended) at the side position. load_tex
# appends it to its preview; the menu redraw re-emits the loaded slots
# so the thumbs survive the C-clear of a setting change.
sm_tex_thumb_line() { tt_n=$1; tt_idx=$2
  tt_col=$(( tt_n % 2 ))
  tt_row=$(( tt_n / 2 ))
  if [ "$tt_col" -eq 0 ]; then tt_bx=170; else tt_bx=1830; fi
  tt_by=$(( 1700 - tt_row * 140 ))
  fmt_ndc $(( tt_bx + 90 )); tt_cx=$fv
  fmt_ndc $(( tt_by - 90 )); tt_cy=$fv
  fmt_pos 180; tt_w=$fv
  tt_line="I $tt_cx $tt_cy $tt_w $tt_w $tt_idx"
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
  if [ "$sm_sel" -eq 5 ]; then sm_mark=">"; else sm_mark=" "; fi
  if [ "$mime_speed" -lt 0 ]; then sm_spd="flee"
  elif [ "$mime_speed" -gt 0 ]; then sm_spd="hunt"
  else sm_spd="off"; fi
  echo "  $sm_mark  mime speed  : $mime_speed $sm_spd"
  if [ "$sm_sel" -eq 6 ]; then sm_mark=">"; else sm_mark=" "; fi
  if [ "$MIME_LABELS" -eq 1 ]; then sm_mlbl="ON"; else sm_mlbl="OFF"; fi
  echo "  $sm_mark  mime names  : $sm_mlbl"
  if [ "$sm_sel" -eq 7 ]; then sm_mark=">"; else sm_mark=" "; fi
  if [ "$SOUND_MODE" = "bash" ]; then sm_snd="BASH"; else sm_snd="NOTES"; fi
  echo "  $sm_mark  sound mode  : $sm_snd"
  if [ "$sm_sel" -eq 8 ]; then sm_mark=">"; else sm_mark=" "; fi
  if [ "$MINIMAP_MODE" -eq 0 ]; then sm_mm="OFF"
  elif [ "$MINIMAP_MODE" -eq 2 ]; then sm_mm="50%"
  else sm_mm="ON"; fi
  echo "  $sm_mark  minimap     : $sm_mm"
  if [ "$sm_sel" -eq 9 ]; then sm_mark=">"; else sm_mark=" "; fi
  echo "  $sm_mark  game speed  : ${game_speed}%"
  if [ "$sm_sel" -eq 10 ]; then sm_mark=">"; else sm_mark=" "; fi
  if [ "$vsync" -eq 1 ]; then sm_vs="ON"; else sm_vs="OFF"; fi
  echo "  $sm_mark  vsync       : $sm_vs"
  # canvas card
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
  sm_spd_s=$(echo "$mime_speed")
  sm_splen=1
  if [ "$mime_speed" -lt 0 ]; then sm_splen=2; fi
  if [ "$mime_speed" -ge 10 ]; then sm_splen=2; fi
  if [ "$mime_speed" -le -10 ]; then sm_splen=3; fi
  if [ "$MIME_LABELS" -eq 1 ]; then sm_mlbl_s="ON"; sm_mlbl_len=2; else sm_mlbl_s="OFF"; sm_mlbl_len=3; fi
  if [ "$SOUND_MODE" = "bash" ]; then sm_snd_s="BASH"; sm_snd_len=4; else sm_snd_s="NOTES"; sm_snd_len=5; fi
  if [ "$MINIMAP_MODE" -eq 0 ]; then sm_mm_s="OFF"; sm_mm_len=3
  elif [ "$MINIMAP_MODE" -eq 2 ]; then sm_mm_s="50%"; sm_mm_len=3
  else sm_mm_s="ON"; sm_mm_len=2; fi
  sm_gs_s=$(echo "$game_speed")
  sm_gslen=1
  if [ "$game_speed" -ge 10 ]; then sm_gslen=2; fi
  if [ "$game_speed" -ge 100 ]; then sm_gslen=3; fi
  if [ "$vsync" -eq 1 ]; then sm_vsync_s="ON"; sm_vsync_len=2; else sm_vsync_s="OFF"; sm_vsync_len=3; fi
  ov_text="C
"
  draw_text "SETTINGS" 8 840 1750 10 14 0.95 0.85 0.30
  draw_text "CAM SHIFT" 9 560 1600 8 11 0.60 0.75 0.95
  draw_text "TEXTURE SIZE" 12 560 1500 8 11 0.60 0.75 0.95
  draw_text "TEXTURE SEED" 12 560 1400 8 11 0.60 0.75 0.95
  draw_text "CRT EFFECT" 10 560 1300 8 11 0.60 0.75 0.95
  draw_text "CORRUPTION" 10 560 1200 8 11 0.60 0.75 0.95
  draw_text "MIME SPEED" 10 560 1100 8 11 0.60 0.75 0.95
  draw_text "MIME NAMES" 10 560 1000 8 11 0.60 0.75 0.95
  draw_text "SOUND MODE" 10 560 900 8 11 0.60 0.75 0.95
  draw_text "MINIMAP" 7 560 800 8 11 0.60 0.75 0.95
  draw_text "GAME SPEED" 10 560 700 8 11 0.60 0.75 0.95
  draw_text "VSYNC" 5 560 600 8 11 0.60 0.75 0.95
  draw_text $sm_shift_s 5 1000 1600 8 11 0.95 0.95 0.95
  draw_text $sm_size_s 2 1000 1500 8 11 0.95 0.95 0.95
  draw_text $sm_seed_s $sm_slen 1000 1400 8 11 0.95 0.95 0.95
  draw_text $sm_crt_s $sm_crt_len 1000 1300 8 11 0.95 0.95 0.95
  draw_text $sm_crp_s $sm_crp_len 1000 1200 8 11 0.95 0.95 0.95
  draw_text $sm_spd_s $sm_splen 1000 1100 8 11 0.95 0.95 0.95
  draw_text $sm_mlbl_s $sm_mlbl_len 1000 1000 8 11 0.95 0.95 0.95
  draw_text $sm_snd_s $sm_snd_len 1000 900 8 11 0.95 0.95 0.95
  draw_text $sm_mm_s $sm_mm_len 1000 800 8 11 0.95 0.95 0.95
  draw_text $sm_gs_s $sm_gslen 1000 700 8 11 0.95 0.95 0.95
  draw_text $sm_vsync_s $sm_vsync_len 1000 600 8 11 0.95 0.95 0.95
  if [ "$sm_sel" -eq 0 ]; then draw_rect "-0.520" "0.583" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 1 ]; then draw_rect "-0.520" "0.483" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 2 ]; then draw_rect "-0.520" "0.383" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 3 ]; then draw_rect "-0.520" "0.283" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 4 ]; then draw_rect "-0.520" "0.183" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 5 ]; then draw_rect "-0.520" "0.083" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 6 ]; then draw_rect "-0.520" "-0.017" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 7 ]; then draw_rect "-0.520" "-0.117" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 8 ]; then draw_rect "-0.520" "-0.217" "0.016" "0.030" 1.0 0.85 0.30
  elif [ "$sm_sel" -eq 9 ]; then draw_rect "-0.520" "-0.317" "0.016" "0.030" 1.0 0.85 0.30
  else draw_rect "-0.520" "-0.417" "0.016" "0.030" 1.0 0.85 0.30; fi
  draw_text "UP/DOWN SELECT - LEFT/RIGHT CHANGE" 34 340 250 7 10 0.85 0.85 0.85
  draw_text "SPACE/ESC START - Q QUIT" 24 500 180 7 10 0.85 0.85 0.85
  # the background-loaded texture thumbs: re-emit the loaded slots (as
  # HUD images) after the C-clear so they persist across redraws
  sm_i=0
  while [ "$sm_i" -lt "$sm_tex_n" ]; do
    sm_tex_thumb_line $sm_i ${sm_tex_idx[$sm_i]}
    ov_text="${ov_text}$tt_line
"
    sm_i=$((sm_i + 1))
  done
  echo "$ov_text" > /dev/webgl/hud
}

settings_menu() {
  if [ "$headless" -eq 1 ]; then return; fi
  sm_mode=$1
  tex_bg_n=0
  sm_bg_i=0
  while [ "$sm_bg_i" -lt "$sm_tex_total" ]; do
    tex_bg_submit ${sm_tex_name[$sm_bg_i]}
    sm_bg_i=$((sm_bg_i + 1))
  done
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
          if [ "$sm_sel" -lt 0 ]; then sm_sel=10; fi
          sm_changed=1
          ;;
        *ArrowDown*)
          sm_sel=$((sm_sel + 1))
          if [ "$sm_sel" -gt 10 ]; then sm_sel=0; fi
          sm_changed=1
          ;;
        *w*)
          sm_sel=$((sm_sel - 1))
          if [ "$sm_sel" -lt 0 ]; then sm_sel=10; fi
          sm_changed=1
          ;;
        *s*)
          sm_sel=$((sm_sel + 1))
          if [ "$sm_sel" -gt 10 ]; then sm_sel=0; fi
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
    # background texture load: on entry/settings change, submit ALL
    # generations as shell background jobs (`&` → worker thread);
    # each loop iteration harvests ONE texture whose job finished. The
    # menu never blocks on generation (the worker computes it); the
    # parse + upload on harvest is fast. Falls back to the synchronous
    # load_tex (one per iteration) when a job's TSV never lands.
    if [ "$tex_size" -ne "$sm_told_size" ] || [ "$tex_seed" -ne "$sm_told_seed" ]; then
      sm_tex_n=0
      sm_told_size=$tex_size
      sm_told_seed=$tex_seed
      tex_bg_n=0
      sm_bg_i=0
      while [ "$sm_bg_i" -lt "$sm_tex_total" ]; do
        tex_bg_submit ${sm_tex_name[$sm_bg_i]}
        sm_bg_i=$((sm_bg_i + 1))
      done
    fi
    if [ "$sm_tex_n" -lt "$sm_tex_total" ]; then
      # the generation runs on a WORKER THREAD (the runtime's & fork
      # heuristic); harvest one texture per iteration as its /tmp TSV
      # lands — the menu never blocks on generation
      tex_bg_done $sm_tex_n
      if [ "$tbg" -eq 1 ]; then
        sm_tex_slot $sm_tex_n
        if [ "${sm_tex_rgba[$sm_tex_n]}" -eq 1 ]; then
          tex_bg_harvest $sm_tex_n ${sm_tex_name[$sm_tex_n]} ${sm_tex_idx[$sm_tex_n]} 4
        else
          tex_bg_harvest $sm_tex_n ${sm_tex_name[$sm_tex_n]} ${sm_tex_idx[$sm_tex_n]} 3
        fi
        sm_tex_n=$((sm_tex_n + 1))
      fi
    fi
    # wipe the back buffer before presenting (see above)
    echo "clear" > /dev/webgl/call
    echo "swap" > /dev/webgl/call
    sleep 0.05
  done
  # the menu's background load is done — main's load_textures replays
  # the /tmp cache with the plain loading-screen geometry
  lt_menu=0
  lt_menu_slot=0
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
    if [ "$MINIMAP_MODE" -ne "$sm_mm_old" ]; then
      # the minimap toggle: rebuild the radar base (skip/dim it) and
      # force the dynamic parts (triangle + blips) to redraw fresh
      hud_static_dirty=1
      prev_px=-1
      prev_pz=-1
      prev_deg=-1
      dm_bi=0
      while [ "$dm_bi" -lt "$mime_count" ]; do
        rmx[$dm_bi]=-1
        rmz[$dm_bi]=-1
        dm_bi=$((dm_bi + 1))
      done
    fi
  fi
  echo ""
  echo "  settings: camera shift $fv · textures ${tex_size}px · seed $tex_seed · mime speed $mime_speed · sound $SOUND_MODE · vsync $vsync"
}

# ─── level progression ─────────────────────────────────────────────
# A fresh level: regenerate the maze + treasures, reset the recovered
# artifacts, clear the mimes and respawn the player in the (always
# carved) spawn pocket. The static HUD/radar/labels rebuild on the
# next frame (hud_static_dirty / labels_dirty).
start_level() {
  # timed (gtick deltas — see g_setup) so the level's maze-gen +
  # treasure-placement + base reset shows as its own setup cost instead
  # of hiding in "other" (level transitions run between game-loop
  # iterations, un-bucketed; the initial level runs before the loop)
  gtick
  r_st0=$g_now
  # the transpiled shell's async store needs a macrotask yield between
  # the phase functions (the same reason main() sleeps between its
  # startup phases) — back-to-back calls let the map writes pile up and
  # count_map_treasures reads stale cells (levels regenerated with no
  # treasures). Each sleep lets the pending writes land.
  gen_maze
  sleep 0.01
  place_treasures
  sleep 0.01
  count_map_treasures
  found_count=0
  fl_i=0
  while [ "$fl_i" -lt "$TREASURE_TOTAL" ]; do
    found[$fl_i]=0
    fl_i=$((fl_i + 1))
  done
  # the player respawns in the spawn pocket (the maze is fresh)
  px=2
  pz=2
  yaw=0
  crouched=0
  anim=0
  # clear the mimes (and their radar blips + 2D banners)
  mime_count=0
  ml_i=0
  while [ "$ml_i" -lt "$CELLS" ]; do
    mime_lookup[$ml_i]=-1
    ml_i=$((ml_i + 1))
  done
  rm_i=0
  while [ "$rm_i" -lt "$MIME_CAP" ]; do
    rmx[$rm_i]=-1
    rmz[$rm_i]=-1
    mblx[$rm_i]=-1
    mbly[$rm_i]=-1
    mblw[$rm_i]=0
    mblh[$rm_i]=0
    rm_i=$((rm_i + 1))
  done
  mblx[$MIME_CAP]=-1
  mbly[$MIME_CAP]=-1
  if [ "$MIMES_ON" -eq 1 ]; then
    spawn_mime
    spawn_mime
    spawn_mime
  fi
  # the radar base, labels and 3D view all change with the new world
  hud_static_dirty=1
  labels_dirty=1
  prev_px=-1
  prev_pz=-1
  prev_deg=-1
  map_ver=$((map_ver + 1))
  mimes_ver=$((mimes_ver + 1))
  gtick
  g_setup=$(( g_setup + g_now - r_st0 ))
}

# LEVEL CLEARED — a popup (terminal + canvas), and the next level does
# NOT start until the player dismisses it (SPACE / Enter / a move key;
# q quits). Heals 1 HP (capped) and advances the level.
level_clear_popup() {
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "   LEVEL $level CLEARED — all $TREASURE_TOTAL artifacts recovered!"
  echo "   score $score · hp $hp/$maxhp"
  echo "   press SPACE for level $((level + 1))"
  echo "═══════════════════════════════════════════════"
  # canvas popup: a dark panel + the text at screen centre. The leading
  # C wipes the old HUD layer; the static base + labels are rebuilt on
  # the next frame after start_level.
  ov_text="C
"
  draw_rect "-0.05" "0.15" "0.90" "0.34" 0.04 0.05 0.09
  draw_text "LEVEL" 5 760 1360 12 16 0.95 0.85 0.30
  lp_lvl=$level
  lp_d1=$((lp_lvl / 10))
  lp_d2=$((lp_lvl % 10))
  if [ "$lp_d1" -gt 0 ]; then draw_char $((lp_d1 + 26)) 1060 1360 12 16 0.95 0.85 0.30; fi
  draw_char $((lp_d2 + 26)) 1120 1360 12 16 0.95 0.85 0.30
  draw_text "CLEARED" 7 760 1210 12 16 0.60 0.95 0.75
  draw_text "ALL ARTIFACTS RECOVERED" 23 660 1070 7 10 0.85 0.85 0.85
  draw_text "PRESS SPACE FOR THE NEXT LEVEL" 30 560 980 7 10 0.85 0.85 0.85
  echo "$ov_text" > /dev/webgl/hud
  echo "swap" > /dev/webgl/call
  # pause until the player dismisses the popup
  lp_done=0
  while [ "$lp_done" -eq 0 ] && [ "$quit" -eq 0 ]; do
    lp_keys=$(cat /dev/webgl/key)
    case $lp_keys in
      *q*)
        quit=1
        lp_done=1
        ;;
      *space*|*Enter*|*Escape*|*w*|*a*|*s*|*d*|*ArrowUp*|*ArrowDown*|*ArrowLeft*|*ArrowRight*)
        lp_done=1
        ;;
    esac
    # heartbeat swap keeps the canvas + the keyboard grab alive
    echo "swap" > /dev/webgl/call
    sleep 0.05
  done
  # wipe the popup (the static rebuild after start_level redraws the HUD)
  echo "C" > /dev/webgl/hud
}

# MINED OUT — an artifact was SHATTERED (shot), so the board can't be
# completed. Same popup + pause as LEVEL CLEARED (SPACE / Enter / a move
# key dismisses; q quits), so the transition to the next level is a
# deliberate beat, not an abrupt cut. No heal — it wasn't a clean win;
# the licence strike carries the penalty (3 strikes revoke it = game over).
mined_out_popup() {
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "   MINED OUT — an artifact was SHATTERED!"
  echo "   score $score · hp $hp/$maxhp · licence $license / 3"
  echo "   press SPACE for level $((level + 1))"
  echo "═══════════════════════════════════════════════"
  # canvas popup: the same dark panel + text as LEVEL CLEARED, with the
  # warning in orange (a lost artifact, not a clean recovery)
  ov_text="C
"
  draw_rect "-0.05" "0.15" "0.90" "0.34" 0.04 0.05 0.09
  draw_text "LEVEL" 5 760 1360 12 16 0.95 0.85 0.30
  mp_lvl=$level
  mp_d1=$((mp_lvl / 10))
  mp_d2=$((mp_lvl % 10))
  if [ "$mp_d1" -gt 0 ]; then draw_char $((mp_d1 + 26)) 1060 1360 12 16 0.95 0.85 0.30; fi
  draw_char $((mp_d2 + 26)) 1120 1360 12 16 0.95 0.85 0.30
  draw_text "MINED OUT" 9 760 1210 12 16 0.95 0.60 0.40
  draw_text "AN ARTIFACT WAS LOST" 22 660 1070 7 10 0.85 0.85 0.85
  draw_text "PRESS SPACE FOR THE NEXT LEVEL" 30 560 980 7 10 0.85 0.85 0.85
  echo "$ov_text" > /dev/webgl/hud
  echo "swap" > /dev/webgl/call
  # pause until the player dismisses the popup
  mp_done=0
  while [ "$mp_done" -eq 0 ] && [ "$quit" -eq 0 ]; do
    mp_keys=$(cat /dev/webgl/key)
    case $mp_keys in
      *q*)
        quit=1
        mp_done=1
        ;;
      *space*|*Enter*|*Escape*|*w*|*a*|*s*|*d*|*ArrowUp*|*ArrowDown*|*ArrowLeft*|*ArrowRight*)
        mp_done=1
        ;;
    esac
    # heartbeat swap keeps the canvas + the keyboard grab alive
    echo "swap" > /dev/webgl/call
    sleep 0.05
  done
  # wipe the popup (the static rebuild after start_level redraws the HUD)
  echo "C" > /dev/webgl/hud
}

print_stats() {
  gtick
  g_total=$(( g_now - g_t0 ))
  if [ "$frame" -gt 0 ]; then
    g_total_ms=$(( g_total / 1000 ))
    g_avg_ms=$(( g_total / frame / 1000 ))
    echo "#stats: frames=$frame time=${g_total_ms}ms avg=${g_avg_ms}ms/frame"
    # per-phase breakdown: ms/frame and % of frame time, plus "other"
    # (unmeasured loop overhead + the gspan ticks themselves)
    g_sum=$(( g_in + g_anim + g_disp + g_mime + g_render + g_hudb + g_hud + g_swap + g_sleepa + g_sleepi ))
    g_other=$(( g_total - g_sum ))
    if [ "$g_other" -lt 0 ]; then g_other=0; fi
    g_ff=$(( g_total / frame ))
    if [ "$g_ff" -lt 1 ]; then g_ff=1; fi
    # the $(…) captures hit the transpiled shell's broken captureSync —
    # compute the values into plain vars first (direct interpolation
    # works on both engines)
    s_in=$((g_in / frame / 1000)); s_inp=$((g_in * 100 / g_total))
    s_anim=$((g_anim / frame / 1000)); s_animp=$((g_anim * 100 / g_total))
    s_disp=$((g_disp / frame / 1000)); s_dispp=$((g_disp * 100 / g_total))
    s_mime=$((g_mime / frame / 1000)); s_mimep=$((g_mime * 100 / g_total))
    s_render=$((g_render / frame / 1000)); s_renderp=$((g_render * 100 / g_total))
    s_hudb=$((g_hudb / frame / 1000)); s_hudbp=$((g_hudb * 100 / g_total))
    s_hud=$((g_hud / frame / 1000)); s_hudp=$((g_hud * 100 / g_total))
    s_swap=$((g_swap / frame / 1000)); s_swapp=$((g_swap * 100 / g_total))
    s_sleep=$((g_sleep / frame / 1000)); s_sleepp=$((g_sleep * 100 / g_total))
    s_other=$((g_other / frame / 1000)); s_otherp=$((g_other * 100 / g_total))
    # the split packs: sleepa/sleepi (already split by gspan), scene (the
    # CPU cull/payload build) + gl-render (the render_frame GL writes =
    # g_rf − g_scene), and the level-setup total
    s_sa=$((g_sleepa / frame / 1000)); s_saip=$((g_sleepa * 100 / g_total))
    s_si=$((g_sleepi / frame / 1000)); s_siip=$((g_sleepi * 100 / g_total))
    s_sc=$((g_scene / frame / 1000))
    s_glr=$(( (g_rf - g_scene) / frame / 1000 ))
    s_setup=$(( g_setup / 1000 ))
    echo "#stats:   input=${s_in}ms/f(${s_inp}%) anim=${s_anim}ms/f(${s_animp}%) disp=${s_disp}ms/f(${s_dispp}%) mime=${s_mime}ms/f(${s_mimep}%)"
    echo "#stats:   scene=${s_sc}ms/f gl-render=${s_glr}ms/f (render=${s_render}ms/f) hudb=${s_hudb}ms/f(${s_hudbp}%) hud=${s_hud}ms/f(${s_hudp}%) swap=${s_swap}ms/f(${s_swapp}%)"
    echo "#stats:   sleep-anim=${s_sa}ms/f(${s_saip}%) sleep-idle=${s_si}ms/f(${s_siip}%) other=${s_other}ms/f(${s_otherp}%) · setup=${s_setup}ms"
    # GL-side HUD cost, timed by the device on the main thread: raster =
    # the 2D-canvas layer draw (inside the /dev/webgl/hud write), upload
    # = the texImage2D/texSubImage2D transfer, composite = the whole
    # swap-side blend (incl. upload + flash). Reported as µs PER
    # OPERATION (the per-frame average hid sub-ms work behind the idle
    # frames — only 44/858 frames touch the HUD here).
    lt_s=$(cat /dev/webgl/stats)
    read_tex_field
    glh_r=$f
    read_tex_field
    glh_u=$f
    read_tex_field
    glh_c=$f
    read_tex_field
    glh_w=$f
    read_tex_field
    glh_n=$f
    glh_rw=0
    glh_uw=0
    glh_cw=0
    if [ "$glh_w" -gt 0 ]; then glh_rw=$(( glh_r / glh_w )); fi
    if [ "$glh_n" -gt 0 ]; then
      glh_uw=$(( glh_u / glh_n ))
      glh_cw=$(( glh_c / glh_n ))
    fi
    echo "#stats:   gl-hud raster=${glh_rw}µs/write(${glh_w}) upload=${glh_uw}µs/comp composite=${glh_cw}µs/swap(${glh_n})"
  else
    # no game frames ran (quit at the settings menu) — nothing was
    # measured, but print the header so a non-demo run still reports
    # its stats block (the same shape the demo prints)
    g_total_ms=$(( g_total / 1000 ))
    echo "#stats: frames=0 time=${g_total_ms}ms avg=0ms/frame — the game was never started"
  fi
  echo "GAME DONE"
}

main() {
  st=$(cat /dev/webgl/state)
  case $st in
    *headless*) sound=$((0)); headless=1 ;;
    *) sound=$((1)); headless=0 ;;
  esac
  # the stats clock starts at the GAME LOOP, not here: g_total used to
  # include the whole startup phase (shader compile, maze gen, texture
  # + label generation, the "ready." sleep) while no gspan bucket did —
  # the loading time amortized into the opaque "other" line (seconds of
  # 32px texture generation spread over the frames). gtick below the
  # loop start re-zeroes the per-frame measurement.
  # immediate feedback FIRST: the banner prints before the slow parts
  # (the wasm shader compile + the texture generation), so the terminal
  # is never silent during startup. The terminal map prints later, after
  # start_level has generated the maze (a pre-maze print showed an
  # all-AIR placeholder). The sleeps between phases are macrotask yields
  # — the browser can't PAINT while a transpiled script runs (its exec
  # calls are one microtask chain), so without them every startup
  # message appears at once when the game loop starts instead of
  # streaming as it loads.
    echo "╔══════════════════════════════════════════════════╗"
  echo "║  MIMEcrofT v6.1 — 3D treasure hunt written in bash ║"
  echo "║  The filesystem is infested with evil MIMEs.     ║"
  echo "║  Recover the lost operating systems.             ║"
  echo "║  Walk INTO the green treasures to recover them.  ║"
  echo "║  Shooting one: -50 score and a licence strike.   ║"
  echo "║  WASD move · arrows turn · SPACE shoot · q quit  ║"
  echo "╚══════════════════════════════════════════════════╝"
  echo ""
  sleep 0.02
  # background sound warm-up: as soon as bash sounds are enabled (the
  # menu's SOUND MODE row or --sounds bash), generate every sound's TSV
  # into the /tmp cache in the background — the first play of each sound
  # is then a cache hit instead of a ~20s generator run. Runs detached
  # (sh2.background) while the shader/maze/textures load; the generator
  # list puts the sounds the opening minutes play first.
  if [ "$SOUND_MODE" = "bash" ] && [ "$precache_done" -eq 0 ]; then
    precache_done=1
    precache_sounds &
  fi
  echo "  compiling the fragment shader…"
  sleep 0.02
    setup_webgl
  # the bash-authored programs compiled by sh2glsl are the only shader
  # source — VERIFY the device actually linked the program: a failed
  # sh2glsl run leaves it with no shaders, and every frame's block draw
  # then rejects with a cryptic "blocks: undefined" (the link error has
  # no .code). Report it once here instead of per frame.
  swgl_p=$(cat /dev/webgl/program)
  case $swgl_p in
    # NOTE: the quoted glob *"program: linked"* transpiles to a regex with
    # LITERAL quotes (a case-lowering bug) and never matches — keep the
    # pattern unquoted (bash case patterns don't need the quotes)
    *program: linked*) echo "  shaders: bash-authored (sh2glsl)" ;;
    *) echo "  !!! shader link FAILED — the 3D view will not render:"
       cat /dev/webgl/log ;;
  esac

  # the stats window covers the settings menu too: a menu quit (q at
  # the pre-game menu) still reports a stats block with the menu
  # elapsed time. The game loop re-zeroes g_t0 right before its own
  # window starts, so a normal play-through is unaffected.
  gtick
  g_t0=$g_now
    if [ "$headless" -eq 0 ] && [ "$demo" -ne 1 ]; then
    settings_menu
    if [ "$quit" -eq 1 ]; then
      echo "== Quit."
      print_stats
      echo "hide" > /dev/webgl/call
      return
    fi
    sleep 0.02
  fi
  start_level
  # the terminal map needs the maze too — print it AFTER gen/placement
  # (before it showed an all-AIR placeholder: the maze is generated in
  # start_level, and the old print ran ahead of it)
  print_map_once
    # the radar base needs the maze — build it now (after gen/placement),
  # not before, so the first static layer has the real walls/treasures
  hud_build_static
    hud_static_dirty=0
  # block textures (generated by examples/textures at startup — cached
  # in /tmp per session so re-runs skip the generation)
  echo "  loading block textures…"
  sleep 0.02
    load_textures
    echo "  generating treasure labels…"
    load_labels
    echo "  generating mime banners…"
    load_mime_labels
    echo "  ready."
  sleep 0.8
  frame=$((0))
  quit=$((0))
  dirty=1
  # the stats window: just before the loop, so the frame buckets and
  # "other" measure ONLY the game loop (the loading above is excluded)
  gtick
  g_t0=$g_now
  # zero the device's GL-side HUD timers so the #stats read below
  # covers exactly this loop window (not the menu / loading)
  echo "reset" > /dev/webgl/stats
  while [ "$quit" -eq 0 ] && [ "$hp" -gt 0 ] && [ "$license" -gt 0 ]; do
  while [ "$quit" -eq 0 ] && [ "$hp" -gt 0 ] && [ "$license" -gt 0 ] && [ "$treasures_left" -gt 0 ]; do
    frame=$((frame + 1))
    # demo mode: a short silent run, then quit so the terminal map
    # above and the #stats block below both print.
    if [ "$demo" -eq 1 ] && [ "$frame" -ge "$DEMO_FRAMES" ]; then quit=1; fi
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
          # the menu's C-wipe cleared the HUD layer (static + labels) —
          # rebuild the base and redraw the labels next frame
          hud_static_dirty=1
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
      gtick
      anim_el=$((g_now - anim_t0))
      dirty=1
      anim_ms_us=$((anim_ms * 1000))
      if [ "$anim_el" -ge "$anim_ms_us" ]; then
        px=${an[3]}
        pz=${an[4]}
        yaw=${an[5]}
        anim=0
        # arrived: if the destination cell holds a hidden treasure, the
        # walk-in claims it (shooting one never does)
        get_cell $px 1 $pz
        if [ "$gv" -eq "$TREASURE" ]; then
          claim_treasure $px $pz
        fi
      fi
    fi
    gspan "anim"
    compute_display
    # the eye ducks/steps up as the cell overhead changes (cheap: one
    # cell read; render_frame reads crouched for the camera height)
    update_crouch
    # muzzle flash lifetime: a few loop frames of flash, then force a
    # clear render so the flash doesn't linger frozen on a static scene.
    # `dirty` is a DEAD flag (the view_key cache made it a no-op), so
    # the expiry needs its own flag or the retained back buffer keeps
    # showing the last flash frame until the next camera move.
    if [ "$muzzle" -gt 0 ]; then
      muzzle=$((muzzle - 1))
      if [ "$muzzle" -eq 0 ]; then
        flash_done=1
      fi
    fi
    gspan "disp"
    # mime step cadence — mime_speed is SIGNED: positive = hunt,
    # negative = flee, 0 = frozen. The modulus uses the magnitude
    # (frame % |speed|); the sign only steers update_mimes' direction.
    mspeed_abs=$mime_speed
    if [ "$mspeed_abs" -lt 0 ]; then mspeed_abs=$((0 - mspeed_abs)); fi
    mstep=1
    if [ "$mspeed_abs" -ne 0 ]; then mstep=$((frame % mspeed_abs)); fi
    if [ "$MIMES_ON" -eq 1 ]; then
      if [ "$mstep" -eq 0 ]; then
        update_mimes
        if [ "$mimes_moved" -eq 1 ]; then dirty=1; fi
      fi
    fi
    gspan "mime"
    # The 3D view is a pure function of the camera pose + the map + the
    # mime positions, so it is CACHED: re-render (the ~768 cell scan +
    # GL dispatch) only when one of those changed. The key carries the
    # CONTINUOUS pose (dpcx_ms/dpcz_ms/dpyw_ms, not the rounded
    # dpx/dpz/dyaw): during a glide every frame advances the camera, so
    # every animation frame re-renders and the world eases instead of
    # freezing until the discrete cell/yaw flips at the halfway point.
    # Idle frames keep a constant key (px·1000 / yaw·90000), so the
    # static view still caches. map_ver bumps on every cell write,
    # mimes_ver on every mime move/die.
    view_key="$dpcx_ms $dpcz_ms $dpyw_ms $crouched $map_ver $mimes_ver"
    hud_swap=0
    if [ "$view_key" != "$prev_view_key" ]; then
      render_frame
      prev_view_key=$view_key
      # the 3D view moved — the treasure labels must track it
      labels_dirty=1
      gspan "render"
      hud_swap=1
    elif [ "$digits_dirty" -eq 1 ] || [ "$muzzle" -gt 0 ] || [ "$hud_static_dirty" -eq 1 ] || [ "$flash_done" -eq 1 ]; then
      # HUD-only frame (FPS digits, muzzle flash, static rebuild): the
      # presented frame is retained (preserveDrawingBuffer) WITH the old
      # HUD baked in, and the HUD layer erases can't reach it — re-render
      # the world so the floor/ceiling planes cover the stale pixels
      # (ghost triangle / mimes / FPS / muzzle) before the new HUD draws.
      render_frame
      prev_view_key=$view_key
      gspan "render"
      hud_swap=1
      flash_done=0
    fi
    # the HUD needs presenting when the view changed, a digit group is
    # dirty (score/hp/art/fps), the muzzle flash is live, or the static
    # radar base was rebuilt — otherwise nothing on screen changed and
    # the frame is fully static (no swap; the keyboard heartbeat below
    # keeps the grab alive)
    if [ "$hud_swap" -eq 1 ] || [ "$digits_dirty" -eq 1 ] || [ "$muzzle" -gt 0 ] || [ "$hud_static_dirty" -eq 1 ]; then
      draw_hud_canvas
      gspan "hud"
      echo "swap" > /dev/webgl/call
      gspan "swap"
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
    # fps: rendered frames per wall-second, sampled once per second
    # (100 frames at the 10ms cap), and the digits only REDRAW when the
    # value actually changed. The old 10-frame sample set digits_dirty
    # every ~100ms, and a digit redraw forces a FULL world re-render —
    # the retained back buffer bakes the old HUD in and the HUD erases
    # can't reach it — so the FPS readout alone re-rendered the whole
    # maze ~10x/sec while idle.
    fps_w=$((frame % 100))
    if [ "$fps_w" -eq 0 ]; then
      gtick
      fps_t=$g_now
      if [ "$fps_t0" -gt 0 ]; then
        fps_dt=$((fps_t - fps_t0))
        if [ "$fps_dt" -gt 0 ] && [ "$fps_rendered" -gt 0 ]; then
          fps_nv=$((fps_rendered * 1000000 / fps_dt))
          if [ "$fps_nv" -ne "$fps" ]; then
            fps=$fps_nv
            digits_dirty=1
          fi
        fi
        fps_rendered=0
      fi
      fps_t0=$fps_t
    fi
    # cpu fps: accumulated CPU µs over the last 60 rendered frames
    if [ "$fps_rendered" -gt 0 ]; then
      gtick_cpu
      cpu_us_acc=$((cpu_us_acc + cpu_us_delta))
      cpu_frame_count=$((cpu_frame_count + 1))
      if [ "$cpu_frame_count" -ge 60 ]; then
        if [ "$cpu_us_acc" -gt 0 ]; then
          cfps_nv=$((3600000000 / cpu_us_acc))
          if [ "$cfps_nv" -ne "$cfps" ]; then
            cfps=$cfps_nv
            digits_dirty=1
          fi
        fi
        cpu_us_acc=0
        cpu_frame_count=0
      fi
    fi
    # frame budget: vsync ON = one frame per display refresh (60Hz →
    # 16.7ms), OFF = the legacy 100fps cap (10ms). Either way the
    # leftover is the sleep; a leftover ≤3ms is a minimum YIELD instead
    # (the browser clamps <4ms timeouts up to ~4-10ms, so sleeping
    # 1-3ms would cost more than yielding with setTimeout(0)). With
    # vsync on the work (~9ms) leaves a REAL ≥4ms sleep, so the clamp
    # never bites and every frame paints exactly once.
    gtick
    fp_el=$((g_now - fp_t0))
    if [ "$vsync" -eq 1 ]; then fp_budget=16667; else fp_budget=10000; fi
    if [ "$fp_el" -lt "$fp_budget" ]; then
      fp_wait=$(((fp_budget - fp_el + 999) / 1000))
      if [ "$fp_wait" -le 3 ]; then fp_wait=0; fi
    else
      fp_wait=0
    fi
    fmt3 $fp_wait
    sleep 0.$fv
    fp_t0=$g_now
    # the sleep itself + the fps-sampling tail of the frame. The pacing
    # yield is split by intent: during an ACTION GLIDE (anim=1) the
    # frame just rendered a moving camera, so this sleep paces a busy
    # frame; IDLE frames (nothing moved, the view cached) are pure
    # pacing with nothing to do.
    if [ "$anim" -eq 1 ]; then
      gspan "sleepa"
    else
      gspan "sleepi"
    fi
  done
    # the level ended: every artifact recovered, or the board mined out
    if [ "$quit" -eq 1 ] || [ "$hp" -le 0 ] || [ "$license" -le 0 ]; then
      break
    fi
    if [ "$found_count" -ge "$treasures_placed" ]; then
      # LEVEL CLEARED — the popup blocks until the player dismisses it
      level_clear_popup
      if [ "$quit" -eq 1 ]; then
        break
      fi
      level=$((level + 1))
      hp=$((hp + 1))
      if [ "$hp" -gt "$maxhp" ]; then hp=$maxhp; fi
      digits_dirty=1
      start_level
      echo ""
      echo "  ── LEVEL $level — $TREASURE_TOTAL artifacts hidden · MIME damage 1-$level ──"
    else
      # mined out — one or more artifacts were SHATTERED by shooting, so
      # this board can't be completed; the dig still moves on to the
      # next level (the licence carries the real penalty: three strikes
      # revoke it and end the game). No heal — it wasn't a clean win.
      # The popup + pause (SPACE/Enter/move; q quits) makes the
      # transition a deliberate beat, exactly like LEVEL CLEARED.
      mined_out_popup
      if [ "$quit" -eq 1 ]; then
        break
      fi
      level=$((level + 1))
      digits_dirty=1
      start_level
      echo ""
      echo "  ── MINED OUT — an artifact was lost; LEVEL $level begins (licence $license / 3) ──"
    fi
  done
  echo "hide" > /dev/webgl/call
  echo ""
  if [ "$quit" -eq 1 ]; then
    echo "== Quit at level $level. Score $score — $found_count artifacts this level. =="
  elif [ "$hp" -le 0 ]; then
    echo "╔════════════════════════════════════════════╗"
    echo "║  GAME OVER — the MIMEs got you on level $level. ║"
    echo "║  $found_count / $TREASURE_TOTAL artifacts recovered.  ║"
    echo "║  Score: $score                             ║"
    echo "╚════════════════════════════════════════════╝"
  elif [ "$license" -le 0 ]; then
    echo "╔════════════════════════════════════════════╗"
    echo "║  GAME OVER — LICENCE REVOKED.               ║"
    echo "║  You shot three artifacts; the Archeology   ║"
    echo "║  Board revoked your licence. Score: $score  ║"
    echo "╚════════════════════════════════════════════╝"
  else
    echo "╔════════════════════════════════════════════╗"
    echo "║  GAME OVER — the MIMEs got you on level $level. ║"
    echo "║  $found_count / $TREASURE_TOTAL artifacts recovered.  ║"
    echo "║  Score: $score                             ║"
    echo "╚════════════════════════════════════════════╝"
  fi
  print_stats
}

main
