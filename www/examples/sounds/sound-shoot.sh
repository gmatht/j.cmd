#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sound-shoot.sh — the "pew" of firing the type-checking ray
# (mimecroft.sh shoot()'s miss note, "D2 0.06").
#
#   bash sound-shoot.sh > pew.wav
#   bash sound-shoot.sh --tsv            # the list of ints
#   bash sound-shoot.sh --preview
#   bash sound-shoot.sh --notes
#   bash sound-shoot.sh --seed 3
#
# Model: a sawtooth sweep 400→1500 Hz over ~90 ms (the classic laser
# rise — a saw, not a sine, because it reads as "gun" not "flute"),
# with a 1 ms noise click at the trigger and a fast-decay tail. All
# integer DSP — the sweep is a linear ramp of the phase increment.
# ─────────────────────────────────────────────────────────────────────

NAME="shoot"
DUR_MS=95
NOTE_SEQ="D2 0.06"

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

inc_of 400
sweep_inc0=$inc16
inc_of 1500
sweep_inc1=$inc16
sweep_steps=$(( DUR_MS * SR / 1000 ))
FADE_AT=$(( sweep_steps - 30 * SR / 1000 ))
ph=0
env=0
CLICK_N=$(( 2 * SR / 1000 ))
i=0
render_sample() {
  if [ "$i" -lt "$CLICK_N" ]; then
    noise16
    samp=$(( nv * 200 / ENV_SCALE ))
  else
    if [ "$i" -eq "$CLICK_N" ]; then env=230; fi
    if [ "$i" -ge "$FADE_AT" ]; then
      env_fade $(( NSAMP - i )) $(( NSAMP - FADE_AT ))
    fi
    wave16 $ph saw
    samp=$(( wv * env / ENV_SCALE * 190 / 256 ))
    ph=$(( ( ph + sweep_inc ) & 65535 ))
    sweep_inc=$(( sweep_inc0 + ( sweep_inc1 - sweep_inc0 ) * i / sweep_steps ))
  fi
}
sound_main
