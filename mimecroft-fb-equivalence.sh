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

# the real-bash reference: same script, fb_* logged for fbrefr to replay
python3 - "$HERE/MIMEcroft_fb.sh" "$WORK/bashref.sh" <<'PY'
import sys
s = open(sys.argv[1]).read()
s = s.replace('KEYS=${MIME_KEYS:-/tmp/mimecroft-keys}',
'''KEYS=${MIME_KEYS:-/tmp/mimecroft-keys}
FBCMD=${FBCMD:-/tmp/fbcmd.log}
: > "$FBCMD"
fb_open()  { { echo "open $SCREEN_W $SCREEN_H"; echo %%; } >> "$FBCMD"; }
fb_clear() { { echo "clear 4278190080"; echo %%; } >> "$FBCMD"; }
fb_set_camera() { { echo "cam $1 $2 $3 $4 $5"; echo %%; } >> "$FBCMD"; }
fb_present() { { echo present; echo %%; } >> "$FBCMD"; }
fb_dump_ppm() { { echo "dump $1"; echo %%; } >> "$FBCMD"; }
fb_blocks() { { printf 'blocks %s\\n' "$1"; echo %%; } >> "$FBCMD"; }''')
s = s.replace('echo "mimecroft-fb: wrote $OUT"',
              '"$FBREFR" "$FBCMD" "$OUT"\necho "mimecroft-fb: wrote $OUT"')
open(sys.argv[2], 'w').write(s)
PY

export FBREFR="$WORK/fbrefr" BASH_O4_SH2PERL="$SH2PERL"
[ -x "$O4" ] || { echo "build bash-O4 first: cargo build --manifest-path /home/llm/sh2loop/bash-o4/Cargo.toml"; exit 1; }
"$O4" -o "$WORK/mimecroft_fb" "$HERE/MIMEcroft_fb.sh" >/dev/null 2>&1 || exit 1

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
    rm -f "$WORK/a.ppm" "$WORK/fbcmd.log"
    MIME_FRAMES=8 MIME_KEYS="$WORK/keys" MIME_OUT="$WORK/a.ppm" FBCMD="$WORK/fbcmd.log" \
        bash "$WORK/bashref.sh" >/dev/null 2>&1
    printf '%s\n' "$keys" > "$WORK/keys"
    rm -f "$WORK/b.ppm"
    MIME_FRAMES=8 MIME_KEYS="$WORK/keys" MIME_OUT="$WORK/b.ppm" \
        "$WORK/mimecroft_fb" >/dev/null 2>&1
    if python3 - "$WORK/a.ppm" "$WORK/b.ppm" <<'PY'
import sys
def px(p):
    d = open(p, 'rb').read()
    return d[d.index(b'255\n') + 4:]
sys.exit(0 if px(sys.argv[1]) == px(sys.argv[2]) else 1)
PY
    then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL on:\n%s\n' "$keys"; fi
done
echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
