#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sound-mime.sh — the "deafening hum" of a nearby evil MIME (the
# proposal's audio/mpeg behaviour; nothing in mimecroft.sh plays it
# yet). A wall of low sawtooth that throbs — you hear it before you
# see it, and it gets louder as it gets closer (mimecroft could scale
# the amp with distance).
#
#   bash sound-mime.sh > mime-hum.wav
#   bash sound-mime.sh --tsv            # the list of ints
#   bash sound-mime.sh --preview
#   bash sound-mime.sh --notes
#   bash sound-mime.sh --seed 8
#
# Model: a 55 Hz sawtooth (the mains hum, but hostile) with an 8 Hz
# tremolo (amplitude wobble — that's the "throb") and a detuned 57 Hz
# sine underneath whose beating adds roughness. 400 ms, no decay: it's
# a drone, the MIME never rests.
# ─────────────────────────────────────────────────────────────────────

NAME="mime"
DUR_MS=400
NOTE_SEQ="A1 0.40"

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

inc_of 55
hum_inc=$inc16
inc_of 57
det_inc=$inc16
hum_ph=0
det_ph=0
# tremolo LFO: 8 Hz, depth = 70% of the envelope
inc_of 8
tr_inc=$inc16
tr_ph=0
TR_DEPTH=180
FADE_N=$(( 10 * SR / 1000 ))
i=0
render_sample() {
  wave16 $hum_ph saw
  hum_s=$wv
  sin16 $det_ph
  # tremolo envelope: 256 - depth + depth * sin(lfo) ∈ [76, 256]
  tr_env=$(( ENV_SCALE - TR_DEPTH + sv * TR_DEPTH / 32767 ))
  samp=$(( ( hum_s * 120 + sv * 50 ) / ENV_SCALE * tr_env / ENV_SCALE ))
  if [ "$i" -ge $(( NSAMP - FADE_N )) ]; then
    env_fade $(( NSAMP - i )) $FADE_N
    samp=$(( samp * env / ENV_SCALE ))
  fi
  hum_ph=$(( ( hum_ph + hum_inc ) & 65535 ))
  det_ph=$(( ( det_ph + det_inc ) & 65535 ))
  tr_ph=$(( ( tr_ph + tr_inc ) & 65535 ))
}
sound_main
