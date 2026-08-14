#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sound-damage.sh — the player getting HURT by a MIME (mimecroft.sh
# hurt()'s "C3 0.15").
#
#   bash sound-damage.sh > damage.wav
#   bash sound-damage.sh --tsv            # the list of ints
#   bash sound-damage.sh --preview
#   bash sound-damage.sh --notes
#   bash sound-damage.sh --seed 5
#
# Model: deliberately dissonant — TWO sawtooth oscillators a minor
# second apart (220 + 233 Hz, the "horror" interval), both sweeping
# down to half pitch while a noise layer bleeds in. The beating
# between the two saws is what makes it hurt; a single sine would just
# be sad. ~260 ms, then it stops — you're damaged, not dying.
# ─────────────────────────────────────────────────────────────────────

NAME="damage"
DUR_MS=260
NOTE_SEQ="C3 0.15"

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

inc_of 220
dmg_inc0=$inc16
inc_of 110
dmg_inc1=$inc16
dmg_steps=$(( DUR_MS * SR / 1000 ))
FADE_AT=$(( dmg_steps - 60 * SR / 1000 ))
# detuned second voice at 233 → 117 Hz
inc_of 233
dmg2_inc0=$inc16
inc_of 117
dmg2_inc1=$inc16
ph=0
ph2=0
env=0
CLICK_N=$(( 2 * SR / 1000 ))
i=0
render_sample() {
  if [ "$i" -lt "$CLICK_N" ]; then
    noise16
    samp=$(( nv * 200 / ENV_SCALE ))
  else
    if [ "$i" -eq "$CLICK_N" ]; then env=255; fi
    if [ "$i" -ge "$FADE_AT" ]; then
      env_fade $(( NSAMP - i )) $(( NSAMP - FADE_AT ))
    fi
    wave16 $ph saw
    wv1=$wv
    wave16 $ph2 saw
    samp=$(( ( wv1 + wv ) * env / ENV_SCALE * 140 / 256 ))
    # noise layer bleeding in (louder as the tone dies)
    noise16
    samp=$(( samp + nv * ( ENV_SCALE - env ) / ENV_SCALE * 60 / 256 ))
    ph=$(( ( ph + dmg_inc ) & 65535 ))
    ph2=$(( ( ph2 + dmg2_inc ) & 65535 ))
    dmg_inc=$(( dmg_inc0 + ( dmg_inc1 - dmg_inc0 ) * i / dmg_steps ))
    dmg2_inc=$(( dmg2_inc0 + ( dmg2_inc1 - dmg2_inc0 ) * i / dmg_steps ))
  fi
}
sound_main
