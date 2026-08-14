#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# sound-treasure.sh — the fanfare when an OS artifact is recovered
# (mimecroft.sh claim_treasure's "C5 0.10" "E5 0.10" "G5 0.15").
#
#   bash sound-treasure.sh > treasure.wav
#   bash sound-treasure.sh --tsv            # the list of ints
#   bash sound-treasure.sh --preview
#   bash sound-treasure.sh --notes
#   bash sound-treasure.sh --seed 2
#
# Model: a 4-note arpeggio — C5 E5 G5 C6 (the classic "found it!"
# major chord) — each note a sine with its own fast-attack/decay
# envelope and a 12 ms overlap so the chord rings. A tiny second
# partial (one octave up, quiet) brightens it. ~460 ms total.
# ─────────────────────────────────────────────────────────────────────

NAME="treasure"
DUR_MS=460
# the fanfare: note freq, note ms, amp (0..256)
TF_N=4
TF_FREQ=(523 659 784 1046)
TF_MS=(100 100 100 120)
TF_AMP=(200 200 210 230)
TF_DECAY=(226 226 226 228)
NOTE_SEQ="C5 0.10|E5 0.10|G5 0.15"

. "$(dirname "$0")/sound-lib.sh"

parse_sound_args "$@"

# precompute per-note sample boundaries + phase increments
tf_i=0
tf_start=(0 0 0 0)
tf_len=(0 0 0 0)
tf_inc=(0 0 0 0)
tf_amp=(0 0 0 0)
tf_dec=(0 0 0 0)
tf_acc=0
while [ "$tf_i" -lt "$TF_N" ]; do
  tf_start[$tf_i]=$tf_acc
  tf_nlen=$(( TF_MS[$tf_i] * SR / 1000 ))
  tf_len[$tf_i]=$tf_nlen
  inc_of ${TF_FREQ[$tf_i]}
  tf_inc[$tf_i]=$inc16
  tf_amp[$tf_i]=${TF_AMP[$tf_i]}
  tf_dec[$tf_i]=${TF_DECAY[$tf_i]}
  tf_acc=$(( tf_acc + tf_nlen - 12 * SR / 1000 ))
  tf_i=$(( tf_i + 1 ))
done
# a quiet octave-up partial on every note
tf_oct=(0 0 0 0)
tf_i=0
while [ "$tf_i" -lt "$TF_N" ]; do
  inc_of $(( TF_FREQ[$tf_i] * 2 ))
  tf_oct[$tf_i]=$inc16
  tf_i=$(( tf_i + 1 ))
done
tf_env=0
ATTACK_N=$(( 6 * SR / 1000 ))
tf_ph=(0 0 0 0)
tf_oph=(0 0 0 0)
tf_note=-1
i=0
render_sample() {
  # find the current note (linear scan — only 4); tf_now=-1 = tail
  tf_n=0
  tf_now=-1
  while [ "$tf_n" -lt "$TF_N" ]; do
    if [ "$i" -ge "${tf_start[$tf_n]}" ] && [ "$i" -lt $(( tf_start[$tf_n] + tf_len[$tf_n] )) ]; then
      tf_now=$tf_n
      tf_n=$TF_N
    fi
    tf_n=$(( tf_n + 1 ))
  done
  if [ "$tf_now" -ne "$tf_note" ]; then
    tf_note=$tf_now
    tf_env=0
  fi
  if [ "$tf_note" -lt 0 ]; then
    samp=0
    return 0
  fi
  # sharp attack, then the note rings down at 255/256 per sample
  if [ "$tf_env" -lt "$ENV_SCALE" ]; then tf_env=$(( tf_env + 60 )); fi
  if [ "$tf_env" -gt "$ENV_SCALE" ]; then tf_env=$ENV_SCALE; fi
  sin16 ${tf_ph[$tf_note]}
  samp=$(( sv * tf_env / ENV_SCALE * ${tf_amp[$tf_note]} / 256 ))
  sin16 ${tf_oph[$tf_note]}
  samp=$(( samp + sv * tf_env / ENV_SCALE * 40 / 256 ))
  env_decay $tf_env 255
  tf_ph[$tf_note]=$(( ( ${tf_ph[$tf_note]} + ${tf_inc[$tf_note]} ) & 65535 ))
  tf_oph[$tf_note]=$(( ( ${tf_oph[$tf_note]} + ${tf_oct[$tf_note]} ) & 65535 ))
}
sound_main
