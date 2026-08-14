#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# make-sounds.sh — batch sound generator for the mimecroft sound
# experiments. Generates every sound as a WAV (HOST bash) and/or as a
# --tsv list of ints (works anywhere).
#
#   bash make-sounds.sh                 WAV mode (HOST bash only):
#                                       writes sound-*.wav in CWD
#   bash make-sounds.sh --tsv [DIR]     TSV mode (works ANYWHERE):
#                                       writes sound-*.tsv (the list
#                                       of ints) into DIR (default:
#                                       current dir; use /home or
#                                       /tmp — /examples is read-only)
#   bash make-sounds.sh --preview       ASCII scope for every sound
#   bash make-sounds.sh --notes         the mimecroft play() calls
#   bash make-sounds.sh --seed 7        one seed for everything
#
# No `exit` anywhere: the transpiled shell's exit kills the whole
# session. SOUNDS is an explicit list — glob expansion is unreliable
# in the transpiled shell.
# ─────────────────────────────────────────────────────────────────────

SOUNDS="hit break thud shoot kill damage treasure shatter walk mime"
SEED_ARGS=""
if [ "$1" = "--seed" ]; then SEED_ARGS="--seed $2"; fi
if [ "$3" = "--seed" ]; then SEED_ARGS="--seed $4"; fi
if [ "$5" = "--seed" ]; then SEED_ARGS="--seed $6"; fi
cd "${0%/*}"
if [ ! -d "$PWD" ] || [ ! -f sound-lib.sh ]; then cd .; fi

if [ "$1" = "--tsv" ]; then
  OUTDIR=$2
  if [ "$OUTDIR" = "" ]; then OUTDIR=.; fi
  echo "writing sound-*.tsv to $OUTDIR"
  for s in $SOUNDS; do
    bash "sound-$s.sh" --tsv $SEED_ARGS > "$OUTDIR/sound-$s.tsv"
    echo "  sound-$s.tsv"
  done
  echo "wrote 10 tsv files to $OUTDIR"
elif [ "$1" = "--preview" ]; then
  for s in $SOUNDS; do
    bash "sound-$s.sh" --preview $SEED_ARGS
  done
elif [ "$1" = "--notes" ]; then
  for s in $SOUNDS; do
    echo "── sound-$s"
    bash "sound-$s.sh" --notes
  done
else
  printf -v probe_ok 'x' 2>/dev/null > /dev/null
  if [ "$probe_ok" != "x" ]; then
    echo "make-sounds.sh (WAV mode) needs HOST bash — this shell's printf can't emit PCM bytes."
    echo "From the repo root on a real machine:  bash examples/sounds/make-sounds.sh"
    echo "(in this shell, use:  bash make-sounds.sh --tsv /home)"
  else
    for s in $SOUNDS; do
      bash "sound-$s.sh" $SEED_ARGS > "sound-$s.wav"
      echo "  sound-$s.wav"
    done
    echo "wrote 9 wav files to CWD"
  fi
fi
