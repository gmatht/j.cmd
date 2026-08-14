#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sound-shatter.sh — an artifact SHATTERING when you shoot it
# (mimecroft.sh shot_treasure's "C4 0.12" + "E2 0.18"). The Board
# warned you: shooting a hidden treasure destroys it (-50 score and a
# licence strike). This is the sound of that mistake — a crystal
# exploding, not the gentle fanfare of walking into one.
#
#   bash sound-shatter.sh > shatter.wav
#   bash sound-shatter.sh --tsv            # the list of ints
#   bash sound-shatter.sh --preview
#   bash sound-shatter.sh --notes
#   bash sound-shatter.sh --seed 4
#
# Model: a 1 ms noise impact (the crack), then THREE detuned high sine
# shards (the glassy partials — the classic "breaking glass" cluster:
# ~2350 / 2790 / 3520 Hz, the C6/E6/A6 ring) each with a fast 16-bit
# exponential decay, plus a quiet 180 Hz glass-body thump underneath.
# All integer DSP — phase accumulators + the sine table, see
# sound-lib.sh. ~340 ms, then the dust settles.
# ─────────────────────────────────────────────────────────────────────

NAME="shatter"
DUR_MS=340
NOTE_SEQ="C4 0.12|E2 0.18"

# the lib is found via bash parameter expansion (${0%/*}), NOT
# $(dirname "$0") — the real-bash wasm bridges command substitution to
# the host shell unexpanded, so dirname "$0" would resolve to "." there.
# The game stages sound-x.sh + sound-lib.sh side by side in /tmp, so
# ${0%/*} lands on the lib; running from the repo (host bash) resolves
# to examples/sounds/. Fall back to CWD for `bash sound-x.sh` from
# inside the directory.
sl_dir=${0%/*}
if [ ! -f "$sl_dir/sound-lib.sh" ]; then sl_dir=.; fi
# the real-bash wasm runs the script at its staged path (/tmp/<name>.sh
# when the game called it, but /script.sh when the path got lost) — the
# game stages sound-lib.sh side by side in /tmp, so fall back to it
# when neither the script's own dir nor the CWD holds the lib
if [ ! -f "$sl_dir/sound-lib.sh" ] && [ -f /tmp/sound-lib.sh ]; then sl_dir=/tmp; fi
. "$sl_dir/sound-lib.sh"

parse_sound_args "$@"

# the shard cluster: three high partials (C6 / E6 / A6 — a bright,
# dissonant-enough spread to read as "glass"), each with its own
# decay rate + amplitude. The LOW shard starts a hair later (the
# impact travels the crystal before the big piece rings).
SH_N=3
SH_FREQ=(2350 2790 3520)
SH_DECAY=(64800 64600 64400)
SH_AMP=(170 140 110)
SH_START=(0 0 6)
CLICK_N=$(( SR / 1000 ))
inc_of 180
thump_inc=$inc16
thump_ph=0
thump_env=0
sh_i=0
sh_inc=(0 0 0)
sh_ph=(0 0 0)
sh_env16=(0 0 0)
while [ "$sh_i" -lt "$SH_N" ]; do
  inc_of ${SH_FREQ[$sh_i]}
  sh_inc[$sh_i]=$inc16
  sh_i=$(( sh_i + 1 ))
done
SH_START_N=(0 0 0)
sh_i=0
while [ "$sh_i" -lt "$SH_N" ]; do
  SH_START_N[$sh_i]=$(( ${SH_START[$sh_i]} * SR / 1000 ))
  sh_i=$(( sh_i + 1 ))
done
i=0
render_sample() {
  if [ "$i" -lt "$CLICK_N" ]; then
    # the crack: white noise, full blast
    noise16
    samp=$(( nv * 260 / ENV_SCALE ))
  else
    samp=0
    if [ "$i" -eq "$CLICK_N" ]; then
      sh_i=0
      while [ "$sh_i" -lt "$SH_N" ]; do
        sh_env16[$sh_i]=65536
        sh_i=$(( sh_i + 1 ))
      done
      thump_env=180
    fi
    # each glassy shard rings down at its own 16-bit rate
    sh_i=0
    while [ "$sh_i" -lt "$SH_N" ]; do
      if [ "$i" -ge "${SH_START_N[$sh_i]}" ]; then
        if [ "$sh_env16" -gt 0 ]; then
          sin16 ${sh_ph[$sh_i]}
          shard=$(( sv * ${sh_env16[$sh_i]} / 65536 * ${SH_AMP[$sh_i]} / 256 ))
          samp=$(( samp + shard ))
          env_decay16 ${sh_env16[$sh_i]} ${SH_DECAY[$sh_i]}
          sh_env16[$sh_i]=$env16
        fi
        sh_ph[$sh_i]=$(( ( ${sh_ph[$sh_i]} + ${sh_inc[$sh_i]} ) & 65535 ))
      fi
      sh_i=$(( sh_i + 1 ))
    done
    # the low glass-body thump, decaying fast
    if [ "$thump_env" -gt 0 ]; then
      sin16 $thump_ph
      samp=$(( samp + sv * thump_env / ENV_SCALE * 90 / 256 ))
      env_decay $thump_env 240
      thump_ph=$(( ( thump_ph + thump_inc ) & 65535 ))
    fi
  fi
}
sound_main
