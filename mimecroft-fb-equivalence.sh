#!/bin/bash
# mimecroft-fb-equivalence.sh — prove the bash-O4 native render equals
# what REAL BASH asks for.
#
#   real bash + fbrefr (runtime/fbdev.c)  -> the frame bash wants
#   bash-O4   + the same script         -> the frame the transpiler wants
#
# Diffing the two images answers "did the transpiler change the game?"
# without trusting the transpiler at all. 23 scripted walks, byte-exact.
set -u
SH2PERL=${SH2PERL:-/home/llm/sh2loop/sh2perl}
O4=${O4:-/home/llm/sh2loop/bash-o4/target/debug/bash-O4}
WORK=${WORK:-/tmp/mime-equiv}
HERE=$(cd "$(dirname "$0")" && pwd)
SH2_RUNTIME=${SH2_RUNTIME:-$SH2PERL/runtime}

mkdir -p "$WORK"
cc -O2 -I"$SH2_RUNTIME" "$HERE/tools/fbrefr.c" "$SH2_RUNTIME/fbdev.c" -lm -o "$WORK/fbrefr" || exit 1

# BALANCED BACKTICKS IN COMMENTS. An odd number of backticks on a line
# opens a command substitution that runs to the end of file, so the
# whole script fails to parse. It fails SILENTLY here: real bash exits
# before drawing, no image is written, and a harness that only diffs
# images reports a traceback — or, worse, nothing at all. This file had
# three such lines and the suite still printed "23 passed". A comment
# is not a place where a quoting mistake should be able to stop a
# program from starting.
for f in "$HERE/MIMEcroft_fb.sh" "$HERE/tools/fb_input_shim.sh"; do
  if awk -v F="$f" '{ n = gsub(/`/, "`") ; if (n % 2) { printf "FATAL: %s:%d: odd number of backticks (%d) - comment opens a command substitution\n", F, NR, n; bad = 1 } } END { exit bad }' "$f"; then
    :
  else
    echo "       fix the quoting before trusting any result from this suite"
    exit 2
  fi
done
bash -n "$HERE/MIMEcroft_fb.sh" || { echo "FATAL: MIMEcroft_fb.sh is not valid bash"; exit 2; }

# The real-bash reference: same script, fb_* logged for fbrefr to replay.
#
# The INPUT side needs a shim too, not just the output side. The game
# reads `rk=$(fb_input_line)` — a device call, which real bash cannot
# make — so the reference script gets tools/fb_input_shim.sh inserted
# verbatim. Both sides then answer "the next key from $FB_KEYS" under
# the same rules, so any difference in the rendered frame is the
# TRANSPILER's rather than the shim's.
#
# The shim is read from its OWN FILE, not embedded here: embedding it
# in this heredoc meant python's own escaping of `$'\n'` had to survive
# a trip through a bash heredoc, and it did not (the generated shim was
# a syntax error, so the whole reference side silently did nothing and
# every case "passed" as a missing file — 0 passed, 23 failed).
python3 - "$HERE/MIMEcroft_fb.sh" "$WORK/bashref.sh" "$HERE/tools/fb_input_shim.sh" <<'PY'
import sys
script, out, shim = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(script).read()
shim_src = open(shim).read()

# 1. the input device shim, verbatim. The anchor is the `map=()` world
#    initialisation, not one of the box-drawing comment rules: a
#    non-ASCII anchor got mangled by an editor round-trip once already
#    and the replacement silently became a no-op.
s = s.replace("map=()", shim_src + "\nmap=()", 1)

# 2. the draw side: log every fb_* call for fbrefr to replay. AFTER the
#    input shim, so it cannot collide with fb_input_line.
DRAW = """FBCMD=${FBCMD:-/tmp/fbcmd.log}
: > "$FBCMD"
fb_open()  { { echo "open $SCREEN_W $SCREEN_H"; echo %%; } >> "$FBCMD"; }
fb_clear() { { echo "clear 4278190080"; echo %%; } >> "$FBCMD"; }
fb_set_camera() { { echo "cam $1 $2 $3 $4 $5"; echo %%; } >> "$FBCMD"; }
fb_present() { { echo present; echo %%; } >> "$FBCMD"; }
fb_dump_ppm() { { echo "dump $1"; echo %%; } >> "$FBCMD"; }
fb_blocks() { { printf 'blocks %s\\n' "$1"; echo %%; } >> "$FBCMD"; }"""
anchor = 'OUT=${MIME_OUT:-/tmp/mimecroft-fb.ppm}'
assert anchor in s
s = s.replace(anchor, anchor + "\n" + DRAW, 1)

s = s.replace('echo "mimecroft-fb: wrote $OUT"',
              '"$FBREFR" "$FBCMD" "$OUT"\necho "mimecroft-fb: wrote $OUT"')
open(out, 'w').write(s)
PY

export FBREFR="$WORK/fbrefr" BASH_O4_SH2PERL="$SH2PERL"
[ -x "$O4" ] || { echo "build bash-O4 first: cargo build --manifest-path /home/llm/sh2loop/bash-o4/Cargo.toml"; exit 1; }
"$O4" -o "$WORK/mimecroft_fb" "$HERE/MIMEcroft_fb.sh" >/dev/null 2>&1 || exit 1

# The device's OWN tests run first, and their result gates the suite.
# The input device is what this suite exercises hardest, and its
# failures are the expensive kind: one that stops the process makes
# every case below fail (or hang) for a reason that has nothing to do
# with the transpiler. Running it here turns that into one clear line.
if [ -f "$SH2_RUNTIME/fbinput-test.c" ] && command -v cc >/dev/null 2>&1; then
    if cc -O1 -I"$SH2_RUNTIME" "$SH2_RUNTIME/fbinput-test.c" \
           "$SH2_RUNTIME/fbinput.c" -lutil -o "$WORK/fbinput-test" 2>/dev/null; then
        # PIPESTATUS, NOT `if ! cmd | sed`. The exit status of a
        # pipeline is the LAST command's — sed's — so a failing device
        # test printed its FAIL line, sed exited 0, and the guard read
        # that as success. The suite then carried on and printed "23
        # passed" underneath a red device test, which is the exact
        # shape of "a broken reference looked exactly like a correct
        # one" that this harness already has a note about.
        timeout -k 2 120 "$WORK/fbinput-test" > "$WORK/fbinput-test.log" 2>&1
        trc=$?
        sed 's/^/  /' "$WORK/fbinput-test.log"
        if [ "$trc" -ne 0 ]; then
            echo "FATAL: the fbinput device fails its own tests (above, rc=$trc)"
            echo "       every case below would be measuring the device, not the game"
            exit 2
        fi
    else
        echo "  fbinput-test: skipped (needs -lutil / pty headers)"
    fi
fi

CASES=(
"" "w" "w
w
w" "e
e
w" "a
a
q
w" "s
s
d" "q
w
e
s" "w
e
w
e
w
e" "r
w
w" "d
d
d
d
d
d" "w
w
w
w
w
w
w
w" "w
w
w
w
w
w
w
w
w
w
w
w" "e
e
e
e
w
w
w" "a
a
a
d
d
d" "q
q
q
q
q
w" "s
s
s
s
w
w" "r
r
w
e
r
d" "w
.
" "." "w
r
e
w
w
q
d" "d
d
d
d
d
d
d
d
d
d
d
d
d
d
d
d" "w
a
s
d
w
a
s
d" "e
w
q
e
w
q
e
w" "e
w
e
e
e
w
w"
)
# THE LAST CASE CLAIMS A TREASURE, and it is the only one that does.
# Every other case ended "0 found", and a game that can never be won
# still passes a suite that only compares the two sides against each
# other: the placement writes TREASURE into layer 1 of an air cell, so
# can_enter refused it, the chest was a wall, and FOUND stayed 0 in all
# 23 runs without a word of complaint. The walk is the shortest path
# from the start to the first treasure in the maze this seed generates
# (see the FOUND check below, which derives it rather than trusting
# this literal).
pass=0; fail=0
for keys in "${CASES[@]}"; do
    printf '%s\n' "$keys" > "$WORK/keys"
    rm -f "$WORK/a.ppm" "$WORK/fbcmd.log" "$WORK/keys.pos"
    # A syntax error in the generated reference script makes bash exit
    # before drawing anything, so a.ppm never appears. The pixel compare
    # below then raises FileNotFoundError and EVERY case "fails" with a
    # traceback that says nothing about the cause. Worse, an earlier
    # version swallowed this entirely and reported "23 passed" against
    # a reference that had never run — so a broken reference looked
    # exactly like a correct one. Parse the generated script up front
    # and stop here if it is not valid bash.
    if ! bash -n "$WORK/bashref.sh"; then
        echo "FATAL: the generated reference script is not valid bash"
        echo "       (the real-bash side would silently do nothing)"
        exit 2
    fi
    sa=$(MIME_FRAMES=8 MIME_KEYS="$WORK/keys" MIME_OUT="$WORK/a.ppm" FBCMD="$WORK/fbcmd.log" \
        timeout -k 2 300 bash "$WORK/bashref.sh" 2>/dev/null | head -1)
    if [ ! -f "$WORK/a.ppm" ]; then
        echo "FATAL: case produced no reference image (real bash failed)"
        printf 'on:\n%s\n' "$keys"
        exit 2
    fi
    printf '%s\n' "$keys" > "$WORK/keys"
    rm -f "$WORK/b.ppm"
    # A TIMEOUT ON THE NATIVE RUN, and it is not a nicety. The game's
    # input is a DEVICE call (fb_input_line), and a device that opens a
    # terminal belonging to another process group is stopped by the
    # kernel the first time it touches it — SIGTTOU for the tcsetattr,
    # SIGTTIN for the read, both of which default to STOP. A stopped
    # process is not slow, it is gone: no image, no message, no exit,
    # and `timeout` does not fire on it either (it is not running, and
    # a plain SIGTERM to a stopped process is queued forever). The
    # suite hung like that, and every case looked like a transpiler
    # failure. Without a bound here a device regression takes the whole
    # run down with no output at all.
    #
    # `timeout -k` also supplies the follow-up KILL, which is what
    # actually clears a stopped process, so the shell is not left
    # holding a corpse that outlives the case.
    sb=$(MIME_FRAMES=8 MIME_KEYS="$WORK/keys" MIME_OUT="$WORK/b.ppm" \
        timeout -k 2 120 "$WORK/mimecroft_fb" 2>/dev/null | head -1)
    rc=$?
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
        echo "FATAL: the native run did not finish (rc=$rc) on:"
        printf '%s\n' "$keys"
        echo "       a game that is STOPPED rather than slow is the"
        echo "       signature of a device touching a foreign terminal"
        exit 2
    fi
    if [ ! -f "$WORK/b.ppm" ]; then
        echo "FATAL: case produced no native image (bash-O4 build failed)"
        printf 'on:\n%s\n' "$keys"
        exit 2
    fi
    if python3 - "$WORK/a.ppm" "$WORK/b.ppm" <<'PY'
import sys
def px(p):
    d = open(p, 'rb').read()
    return d[d.index(b'255\n') + 4:]
sys.exit(0 if px(sys.argv[1]) == px(sys.argv[2]) else 1)
PY
    then pass=$((pass + 1)); else
        fail=$((fail + 1))
        # A failure that only says DIFF is useless: report the two
        # games' own status lines too, so the difference is legible
        # (a different cell/yaw/steps is a game-logic divergence; two
        # identical lines means the game agreed and the DEVICE
        # disagreed).
        printf 'FAIL on:\n%s\n  bash  | %s\n  bashO4| %s\n' "$keys" "$sa" "$sb"
    fi
    # DID ANYTHING GET DRAWN AT ALL? Equality alone cannot say. Both
    # sides replay through the SAME fbdev.c, so a game that renders a
    # flat grey wall is byte-identical on both and the suite calls it a
    # pass — which is exactly what happened: the world arrays were sized
    # to CELLS (256) while cells index to 767, so every layer-1/2 cell
    # read back empty, every cube record lost its 11th field, the
    # device desynchronised and the frame came out a single flat colour.
    # All 23 cases passed, byte for byte, of an image with no maze in
    # it. A comparison that cannot fail is not a test.
    if python3 - "$WORK/b.ppm" <<'PY'
import sys
d = open(sys.argv[1], 'rb').read()
px = d[d.index(b'255\n') + 4:]
from collections import Counter
c = Counter(px[o:o + 3] for o in range(0, len(px), 3))
# THE FRAME MUST NOT BE FLAT.
#
# The failure this catches: a desynchronised block payload leaves one
# stretched background plane covering the whole screen, so the frame is
# a single colour and 100% of it. A real frame is never flat — the
# nearest correct render still has sky, floor and several face shades,
# and the one that looks most uniform (a wall filling the view) still
# tops out under half the screen.
#
# Both halves matter. "At least N colours" alone would fail a correct
# render for being simple; "not all one colour" alone would pass a frame
# where the parser desynchronised on the LAST record only, leaving one
# stray pixel. Requiring several distinct shades AND no single colour
# covering the screen rejects both, and accepts every frame the game can
# legitimately produce.
if len(c) < 3:
    sys.exit(1)
if c.most_common(1)[0][1] * 100 >= len(px) // 3 * 100 * 0.97:
    sys.exit(1)
sys.exit(0)
PY
    then :; else
        fail=$((fail + 1))
        n=$(python3 -c "
from collections import Counter
d = open('$WORK/b.ppm','rb').read()
px = d[d.index(b'255\n') + 4:]
c = Counter(px[o:o+3] for o in range(0, len(px), 3))
top = c.most_common(1)[0]
print('%d colour(s), the top one covers %.0f%% of the frame' % (len(c), 100.0*top[1]/76800))")
        printf 'FLAT on:\n%s\n  the two sides AGREE, but %s:\n' "$keys" "$n"
        printf '  a real frame has sky, floor and several face shades. One\n'
        printf '  colour filling the screen is a desynchronised block payload:\n'
        printf '  both sides share fbdev.c, so it matches itself and this\n'
        printf '  suite cannot see it.\n'
    fi
done
echo "== $pass passed, $fail failed =="

# CAN THE GAME BE WON AT ALL? The cases above prove the two sides
# agree. They cannot prove either side is CORRECT: two identical wrong
# programs agree perfectly. A game whose goal is unreachable is the
# sharpest version of that, and this one was unwinnable — can_enter
# refused a treasure cell, so FOUND was structurally always 0, and 23
# byte-exact passes said nothing was wrong.
#
# The check is a real playthrough: rebuild the maze the script's own
# gen_maze/placement produce for its seed, BFS to the first treasure
# under the rule can_enter implements, and drive that path through the
# real binary. Derived rather than hard-coded, so a change to the seed
# or the maze cannot leave this asserting a stale path.
found=$(timeout -k 2 180 python3 - "$HERE/MIMEcroft_fb.sh" "$WORK/mimecroft_fb" <<'PY'
import os, subprocess, sys, collections
script, game = sys.argv[1], sys.argv[2]

# the script's own constants, read rather than duplicated
txt = open(script).read()
def const(name, default=None):
    for line in txt.split('\n'):
        if line.startswith(name + '='):
            return int(line.split('=', 1)[1].split('#')[0].strip())
    return default
MAP_W, MAP_D, MAP_H = const('MAP_W'), const('MAP_D'), const('MAP_H')
CELLS = MAP_W * MAP_D
AIR, STONE, OBSIDIAN, TREASURE = 0, 2, 3, 7

m = {}
def setc(a, b, c, v): m[(b, a, c)] = v
def getc(a, b, c): return m.get((b, a, c), 0)
for x in range(MAP_W):
    for z in range(MAP_D):
        setc(x, 0, z, 1); setc(x, 1, z, STONE); setc(x, 2, z, STONE)
for sx in range(1, 4):
    for sz in range(1, 4):
        setc(sx, 1, sz, AIR); setc(sx, 2, sz, AIR)
seed = 20240812
def nmrand(m_):
    global seed
    seed = (seed * 48271) % 2147483647
    return seed % m_
cx = cz = 2; steps = 0
while steps < MAP_W * MAP_D * 55 // 100:
    setc(cx, 1, cz, AIR); setc(cx, 2, cz, AIR)
    r = nmrand(4)
    if r == 0: cx += 1
    if r == 1: cx -= 1
    if r == 2: cz += 1
    if r == 3: cz -= 1
    cx = max(1, min(MAP_W - 2, cx)); cz = max(1, min(MAP_D - 2, cz))
    steps += 1
bx, bz = MAP_W - 1, MAP_D - 1
for x in range(MAP_W):
    for z in range(MAP_D):
        if x in (0, bx) or z in (0, bz):
            setc(x, 0, z, OBSIDIAN); setc(x, 1, z, OBSIDIAN); setc(x, 2, z, OBSIDIAN)
ci = MAP_W - 2
for x in range(1, ci + 1):
    for cell in ((x, 1, 1), (x, 1, ci), (1, 1, x), (ci, 1, x),
                 (x, 2, 1), (x, 2, ci), (1, 2, x), (ci, 2, x)):
        setc(*cell, AIR)
placed = []
tp = 0
while tp < 4:
    tries = 0
    while tries < 100:
        rx = nmrand(14) + 1; rz = nmrand(14) + 1
        if getc(rx, 1, rz) == AIR and getc(rx, 2, rz) == AIR:
            setc(rx, 1, rz, TREASURE); placed.append((rx, rz)); break
        tries += 1
    tp += 1

# can_enter's rule: layer 1 is air OR a treasure, layer 2 is air
def walk(x, z):
    return getc(x, 1, z) in (AIR, TREASURE) and getc(x, 2, z) == AIR

start = (2, 2)
prev = {start: None}; q = collections.deque([start]); goal = None
while q:
    x, z = q.popleft()
    if getc(x, 1, z) == TREASURE:
        goal = (x, z); break
    for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        n = (x + dx, z + dz)
        if 1 <= n[0] < bx and 1 <= n[1] < bz and n not in prev and walk(*n):
            prev[n] = (x, z); q.append(n)
if goal is None:
    print("NO-TREASURE-REACHABLE"); sys.exit(0)

path = []; cur = goal
while prev[cur] is not None:
    path.append(cur); cur = prev[cur]
path.reverse()
# yaw 0=-z 1=+x 2=+z 3=-x;  w = forward,  e = turn right (yaw+1)
keys = []; yaw = 2; at = start
for (x, z) in path:
    want = {(1, 0): 1, (-1, 0): 3, (0, 1): 2, (0, -1): 0}[(x - at[0], z - at[1])]
    while yaw != want:
        keys.append('e'); yaw = (yaw + 1) % 4
    keys.append('w')
    at = (x, z)
kf = sys.argv[1].replace('.sh', '') + '.winkeys'
out = '/tmp/mime-wintrace.ppm'
for p in (kf + '.pos', kf, out):
    try: os.unlink(p)
    except OSError: pass
open(kf, 'w').write('\n'.join(keys) + '\n')
env = dict(os.environ, MIME_FRAMES=str(len(keys)), MIME_KEYS=kf, MIME_OUT=out)
r = subprocess.run([game], env=env, capture_output=True, text=True, timeout=120)
# the key file is the probe's scratch, not something to leave in the
# source tree for the next run to trip over
for p in (kf + '.pos', kf):
    try: os.unlink(p)
    except OSError: pass
line = r.stdout.strip().split('\n')[0] if r.stdout.strip() else '(no output)'
print(line)
PY
)
case "$found" in
  *", 0 found"*)
    echo "FATAL: the game cannot be won - $found"
    echo "       a treasure cell is unreachable, so FOUND can never leave 0."
    echo "       the cases above still passed: they compare the two sides"
    echo "       against each other, and two identical unwinnable games agree."
    exit 2
    ;;
  *"found"*) echo "  winnable: $found" ;;
  NO-TREASURE-REACHABLE)
    echo "FATAL: no treasure is reachable in the generated maze"
    exit 2 ;;
  *) echo "FATAL: the winnability probe produced nothing useful: $found"; exit 2 ;;
esac

[ "$fail" -eq 0 ]
