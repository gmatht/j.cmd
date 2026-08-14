#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sound-break.sh — a block BREAKING: the crack-and-fall sound when the
# last shot destroys a block (mimecroft.sh damage_cell's E3 0.06).
#
#   bash sound-break.sh > break.wav
#   bash sound-break.sh --tsv            # the list of ints
#   bash sound-break.sh --preview
#   bash sound-break.sh --notes
#   bash sound-break.sh --material dirt  # softer, lower rubble
#
# Model: three stages, all integer DSP —
#   1. crack: 12 ms of bright noise (the block shattering)
#   2. debris: a fast downward noise-filtered rattle (amp decays hard)
#   3. thud: a 150→80 Hz sine drop (the block hitting the floor),
#      weighted by material (obsidian/stone fall heavy, dirt soft).
# ─────────────────────────────────────────────────────────────────────

NAME="break"
DUR_MS=190
MATERIAL=stone
# material weight: thud freq start, thud amp (0..256)
BRK_F0=(0 150 110 130 200 220)
BRK_AMP=(0 130 90 100 150 160)
NOTE_SEQ="E3 0.06"

. "$(dirname "$0")/sound-lib.sh"

parse_sound_args "$@"
if [ "$ARG_EXTRA" != "" ]; then
  br_w=$ARG_EXTRA
  case $br_w in
    *dirt*) MATERIAL=dirt ;;
    *wood*) MATERIAL=wood ;;
    *gold*) MATERIAL=gold ;;
    *gem*) MATERIAL=gem ;;
  esac
fi

case $MATERIAL in
  dirt) BR_I=2 ;;
  wood) BR_I=3 ;;
  gold) BR_I=4 ;;
  gem) BR_I=5 ;;
  *) BR_I=1 ;;
esac

THUD_F0=${BRK_F0[$BR_I]}
THUD_AMP=${BRK_AMP[$BR_I]}
CRACK_MS=12
RATTLE_MS=45
CRACK_N=$(( CRACK_MS * SR / 1000 ))
RATTLE_N=$(( ( CRACK_MS + RATTLE_MS ) * SR / 1000 ))
THUD_LEN=0
inc_of $THUD_F0
thud_inc0=$inc16
inc_of 80
thud_inc1=$inc16
thud_ph=0
thud_env=0
ratt_inc=$(( ( thud_inc0 + thud_inc1 ) / 2 ))
ratt_ph=0
ratt_env=0
i=0
render_sample() {
  if [ "$i" -lt "$CRACK_N" ]; then
    # crack: raw noise, very fast decay, loud
    noise16
    if [ "$i" -lt 2 ]; then
      env=$(( i * ENV_SCALE / 2 ))
    else
      env_decay $env 170
    fi
    if [ "$i" -eq 0 ]; then env=0; fi
    samp=$(( nv * env / ENV_SCALE ))
  elif [ "$i" -lt "$RATTLE_N" ]; then
    # debris rattle: noise through a decaying envelope + a low tone
    noise16
    if [ "$i" -eq "$CRACK_N" ]; then ratt_env=230; fi
    env_decay $ratt_env 185
    wave16 $ratt_ph saw
    samp=$(( nv * ratt_env / ENV_SCALE / 3 + wv * ratt_env / ENV_SCALE / 6 ))
    ratt_ph=$(( ( ratt_ph + ratt_inc ) & 65535 ))
  else
    # thud: sine sweeping 150→80 Hz, fading linearly over the tail
    if [ "$i" -eq "$RATTLE_N" ]; then
      thud_env=250
      thud_len=$(( NSAMP - RATTLE_N ))
    fi
    env_fade $(( NSAMP - i )) $thud_len
    sin16 $thud_ph
    samp=$(( sv * thud_env / ENV_SCALE * THUD_AMP / 256 ))
    thud_ph=$(( ( thud_ph + thud_inc ) & 65535 ))
    thud_inc=$(( thud_inc0 + ( thud_inc1 - thud_inc0 ) * ( i - RATTLE_N ) / thud_len ))
  fi
}
sound_main
