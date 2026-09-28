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
w"
)
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
done
echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
