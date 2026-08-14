#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sound-kill.sh — the MIME death wail: a sanitised content type
# descending into nothing (mimecroft.sh kill_mime_at's "G5 0.08").
#
#   bash sound-kill.sh > kill.wav
#   bash sound-kill.sh --tsv            # the list of ints
#   bash sound-kill.sh --preview
#   bash sound-kill.sh --notes
#   bash sound-kill.sh --seed 9
#
# Model: a sawtooth sweeping 700→110 Hz over ~280 ms with a wobbling
# pitch (vibrato — an LFO phase added to the phase increment, which is
# what makes it sound like a *wail* instead of a slide), ending in a
# 60 ms noise gasp. The saw + vibrato gives it an angry, non-musical
# character — the MIME is a corrupted file, not a choir.
# ─────────────────────────────────────────────────────────────────────

NAME="kill"
DUR_MS=300
NOTE_SEQ="G5 0.08"

. "$(dirname "$0")/sound-lib.sh"

parse_sound_args "$@"

inc_of 700
wail_inc0=$inc16
inc_of 110
wail_inc1=$inc16
wail_steps=$(( DUR_MS * SR / 1000 ))
FADE_AT=$(( wail_steps - 80 * SR / 1000 ))
ph=0
env=0
# vibrato: LFO at ~7 Hz, depth ~±35 Hz → phase-increment units
inc_of 7
vib_inc=$inc16
vib_ph=0
inc_of 35
vib_depth=$inc16
GASP_N=$(( ( DUR_MS - 60 ) * SR / 1000 ))
CLICK_N=$(( 2 * SR / 1000 ))
i=0
render_sample() {
  if [ "$i" -lt "$CLICK_N" ]; then
    noise16
    samp=$(( nv * 220 / ENV_SCALE ))
  elif [ "$i" -lt "$GASP_N" ]; then
    if [ "$i" -eq "$CLICK_N" ]; then env=250; fi
    if [ "$i" -ge "$FADE_AT" ]; then
      env_fade $(( GASP_N - i )) $(( GASP_N - FADE_AT ))
    fi
    wave16 $ph saw
    samp=$(( wv * env / ENV_SCALE * 200 / 256 ))
    # pitch: downward sweep + vibrato wobble
    sin16 $vib_ph
    wail_inc=$(( wail_inc0 + ( wail_inc1 - wail_inc0 ) * i / wail_steps + sv * vib_depth / 32767 ))
    if [ "$wail_inc" -lt "$wail_inc1" ]; then wail_inc=$wail_inc1; fi
    ph=$(( ( ph + wail_inc ) & 65535 ))
    vib_ph=$(( ( vib_ph + vib_inc ) & 65535 ))
  else
    # death gasp: noise fading out fast
    noise16
    if [ "$i" -eq "$GASP_N" ]; then env=160; fi
    env_decay $env 200
    samp=$(( nv * env / ENV_SCALE ))
  fi
}
sound_main
