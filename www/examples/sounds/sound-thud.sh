#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sound-thud.sh — the dull THUD of shooting an indestructible block
# (mimecroft.sh damage_cell's obsidian branch, "G2 0.10"). The maze
# border is solid obsidian, so you hear this a lot — it should read as
# "you wasted that shot".
#
#   bash sound-thud.sh > thud.wav
#   bash sound-thud.sh --tsv            # the list of ints
#   bash sound-thud.sh --preview
#   bash sound-thud.sh --notes
#   bash sound-thud.sh --seed 7         # another noise lick
#
# Model: a 2 ms noise impact, then a 100→65 Hz sine sweep with a slow,
# heavy decay — plus a quieter 50 Hz sub-hit that starts 12 ms in (the
# stone "settling" after the blow). Big and round, no harmonics.
# ─────────────────────────────────────────────────────────────────────

NAME="thud"
DUR_MS=180
NOTE_SEQ="G2 0.10"

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

inc_of 100
thud_inc0=$inc16
inc_of 65
thud_inc1=$inc16
thud_ph=0
thud_env=0
inc_of 50
sub_inc=$inc16
sub_ph=0
sub_env=0
IMPACT_N=$(( 2 * SR / 1000 ))
SUB_N=$(( 12 * SR / 1000 ))
i=0
render_sample() {
  if [ "$i" -lt "$IMPACT_N" ]; then
    noise16
    samp=$(( nv * 180 / ENV_SCALE ))
  else
    if [ "$i" -eq "$IMPACT_N" ]; then
      thud_env=240
      thud_len=$(( NSAMP - IMPACT_N ))
    fi
    env_fade $(( NSAMP - i )) $thud_len
    sin16 $thud_ph
    samp=$(( sv * thud_env / ENV_SCALE * 220 / 256 ))
    thud_ph=$(( ( thud_ph + thud_inc ) & 65535 ))
    thud_inc=$(( thud_inc0 + ( thud_inc1 - thud_inc0 ) * ( i - IMPACT_N ) / thud_len ))
    # sub hit: second low sine, quieter, kicks in late
    if [ "$i" -ge "$SUB_N" ]; then
      if [ "$i" -eq "$SUB_N" ]; then sub_env=150; fi
      env_decay $sub_env 252
      sin16 $sub_ph
      samp=$(( samp + sv * sub_env / ENV_SCALE * 70 / 256 ))
      sub_ph=$(( ( sub_ph + sub_inc ) & 65535 ))
    fi
  fi
}
sound_main
