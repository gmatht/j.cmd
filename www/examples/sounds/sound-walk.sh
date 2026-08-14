#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sound-walk.sh — a footstep: the sound mimecroft.sh does NOT have
# yet. One "step" = a heel thump + a toe scuff ~150 ms later, soft
# noise + a low sine, so walking through the maze sounds like gravel
# under boots instead of silence.
#
#   bash sound-walk.sh > step.wav
#   bash sound-walk.sh --tsv            # the list of ints
#   bash sound-walk.sh --preview
#   bash sound-walk.sh --notes
#   bash sound-walk.sh --seed 4         # different scuff rattle
#
# Model: two 45 ms bursts — each is noise through a fast-decay
# envelope plus a 150 Hz sine thump; the second (toe) is slightly
# higher and quieter. The noise lick is LCG-seeded, so different seeds
# sound like different floor textures (try dirt vs stone by ear).
# ─────────────────────────────────────────────────────────────────────

NAME="walk"
DUR_MS=220
NOTE_SEQ="A1 0.04"

# the lib is found via bash parameter expansion (${0%/*}), NOT
# $(dirname "$0") — the real-bash wasm bridges command substitution to
# the host shell unexpanded, so dirname "$0" would resolve to "." there.
# The game stages sound-x.sh + sound-lib.sh side by side in /tmp, so
# ${0%/*} lands on the lib; running from the repo (host bash) resolves
# to examples/sounds/. Fall back to CWD for `bash sound-x.sh` from
# inside the directory.
sl_dir=${0%/*}
if [ ! -f "$sl_dir/sound-lib.sh" ]; then sl_dir=.; fi
# the real-bash wasm can land the script at /script.sh (the staged
# path gets lost) — the game stages sound-lib.sh side by side in /tmp,
# so fall back to it when neither the script's dir nor the CWD holds it
if [ ! -f "$sl_dir/sound-lib.sh" ] && [ -f /tmp/sound-lib.sh ]; then sl_dir=/tmp; fi
. "$sl_dir/sound-lib.sh"

parse_sound_args "$@"

STEP_N=$(( 45 * SR / 1000 ))
GAP_N=$(( 150 * SR / 1000 ))
inc_of 150
thump_inc=$inc16
inc_of 170
toe_inc=$inc16
thump_ph=0
toe_ph=0
thump_env=0
toe_env=0
i=0
render_sample() {
  if [ "$i" -lt "$STEP_N" ]; then
    # heel: noise + 150 Hz thump
    noise16
    if [ "$i" -eq 0 ]; then thump_env=0; fi
    if [ "$thump_env" -lt 120 ]; then thump_env=$(( thump_env + 24 )); fi
    env_decay $thump_env 253
    sin16 $thump_ph
    samp=$(( ( nv * thump_env / ENV_SCALE / 3 + sv * thump_env / ENV_SCALE ) * 130 / 256 ))
    thump_ph=$(( ( thump_ph + thump_inc ) & 65535 ))
  elif [ "$i" -ge "$GAP_N" ] && [ "$i" -lt $(( GAP_N + STEP_N )) ]; then
    # toe: quieter scuff at a slightly higher pitch
    noise16
    if [ "$i" -eq "$GAP_N" ]; then toe_env=0; fi
    if [ "$toe_env" -lt 90 ]; then toe_env=$(( toe_env + 18 )); fi
    env_decay $toe_env 253
    sin16 $toe_ph
    samp=$(( ( nv * toe_env / ENV_SCALE / 3 + sv * toe_env / ENV_SCALE ) * 100 / 256 ))
    toe_ph=$(( ( toe_ph + toe_inc ) & 65535 ))
  else
    samp=0
  fi
}
sound_main
