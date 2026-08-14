#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sound-hit.sh — a block-hit "tick": the sound of one shot striking a
# block that does NOT break yet (mimecroft.sh damage_cell's C3 0.05).
#
# The experiment: the tick is MATERIAL-dependent — stone rings, dirt
# thumps dull, gold glints metallic, gems ping high — so mining a maze
# made of different blocks *sounds* different:
#
#   bash sound-hit.sh > hit-stone.wav        # default: stone
#   bash sound-hit.sh --material dirt
#   bash sound-hit.sh --material gold --tsv  # list of ints
#   bash sound-hit.sh --material wood --preview
#   bash sound-hit.sh --material gem  --notes
#
# Model: a 1 ms noise impact click, then a sine tone at the material's
# pitch with a fast exponential decay (and a tiny second partial on the
# "metallic" materials). All integer DSP — see sound-lib.sh.
# ─────────────────────────────────────────────────────────────────────

NAME="hit"
DUR_MS=55
MATERIAL=stone
# per-material tone: freq, wave, decay16 (0..65535), amp(0..256),
# partial freq (0=none)
MAT_FREQ=(0 1046 392 523 1568 2093)
MAT_WAVE=("" sine sine sine sine sine)
MAT_DECAY=(0 65000 64600 64800 65000 65100)
MAT_AMP=(0 130 110 120 140 150)
MAT_PAR=(0 0 0 0 2350 3140)
NOTE_SEQ="C6 0.05"

. "$(dirname "$0")/sound-lib.sh"

parse_sound_args "$@"
if [ "$ARG_EXTRA" != "" ]; then
  # --material NAME — one of: stone dirt wood gold gem
  ma_w=$ARG_EXTRA
  case $ma_w in
    *stone*) MATERIAL=stone ;;
    *dirt*) MATERIAL=dirt ;;
    *wood*) MATERIAL=wood ;;
    *gold*) MATERIAL=gold ;;
    *gem*) MATERIAL=gem ;;
  esac
fi

case $MATERIAL in
  dirt) MAT_I=2 ;;
  wood) MAT_I=3 ;;
  gold) MAT_I=4 ;;
  gem) MAT_I=5 ;;
  *) MAT_I=1 ;;
esac

FREQ=${MAT_FREQ[$MAT_I]}
WAVE=${MAT_WAVE[$MAT_I]}
DECAY=${MAT_DECAY[$MAT_I]}
AMP=${MAT_AMP[$MAT_I]}
PAR=${MAT_PAR[$MAT_I]}
inc_of $FREQ
ph_inc=$inc16
ph=0
par_inc=0
par_ph=0
if [ "$PAR" -ne 0 ]; then inc_of $PAR; par_inc=$inc16; fi
# 1 ms noise click on impact, then the tone (16-bit envelope)
CLICK_MS=$(( SR / 1000 ))
env16=0
i=0
render_sample() {
  if [ "$i" -lt "$CLICK_MS" ]; then
    # attack ramp + impact noise
    noise16
    env=$(( i * ENV_SCALE / CLICK_MS ))
    samp=$(( nv * env / ENV_SCALE ))
    env16=65536
  else
    wave16 $ph $WAVE
    samp=$wv
    if [ "$PAR" -ne 0 ]; then
      sin16 $par_ph
      samp=$(( samp + sv * 40 / 256 ))
    fi
    samp=$(( samp * env16 / 65536 * AMP / 256 ))
    env_decay16 $env16 $DECAY
  fi
  ph=$(( ( ph + ph_inc ) & 65535 ))
  par_ph=$(( ( par_ph + par_inc ) & 65535 ))
}
sound_main
