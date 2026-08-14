#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# audition-sounds.sh — hear the mimecroft sound experiments.
#
# For each sound it echoes the name to the terminal and plays the
# sound immediately after — an A/B audition of every effect in the
# set, in the order mimecroft would use them:
#
#   bash audition-sounds.sh              # echo name → play, per sound
#   bash audition-sounds.sh --seed 7     # one seed for all licks
#   bash audition-sounds.sh --repeat 2   # each sound twice
#   bash audition-sounds.sh --preview    # visual only (ASCII scopes)
#
# Needs host bash (printf -v to build the WAVs) and an audio player:
# aplay / paplay / pw-play / play / ffplay / cvlc, first found wins.
# With no player — or when the player fails (e.g. a headless box with
# no sound card) — each sound falls back to its ASCII oscilloscope, so
# the audition still "plays" visually. No `exit` anywhere: the
# transpiled shell's exit kills the whole session.
# ─────────────────────────────────────────────────────────────────────

SOUNDS="hit break thud shoot kill damage treasure shatter walk mime"
SEED_ARGS=""
REPEAT=1
if [ "$1" = "--seed" ]; then SEED_ARGS="--seed $2"; fi
if [ "$3" = "--seed" ]; then SEED_ARGS="--seed $4"; fi
if [ "$5" = "--seed" ]; then SEED_ARGS="--seed $6"; fi
if [ "$1" = "--repeat" ]; then REPEAT=$2; fi
if [ "$3" = "--repeat" ]; then REPEAT=$4; fi
if [ "$5" = "--repeat" ]; then REPEAT=$6; fi
FORCE_PREVIEW=0
if [ "$1" = "--preview" ]; then FORCE_PREVIEW=1; fi
if [ "$2" = "--preview" ]; then FORCE_PREVIEW=1; fi
if [ "$3" = "--preview" ]; then FORCE_PREVIEW=1; fi
if [ "$4" = "--preview" ]; then FORCE_PREVIEW=1; fi
if [ "$5" = "--preview" ]; then FORCE_PREVIEW=1; fi
if [ "$6" = "--preview" ]; then FORCE_PREVIEW=1; fi
cd "${0%/*}"
if [ ! -d "$PWD" ] || [ ! -f sound-lib.sh ]; then cd .; fi

# can we build WAVs at all? (needs printf -v: host bash)
printf -v probe_ok 'x' 2>/dev/null > /dev/null

# pick the first player that exists
PLAYER=""
PLAYER_NAME=""
if command -v aplay >/dev/null 2>&1; then
  PLAYER="aplay"; PLAYER_NAME="aplay"
elif command -v paplay >/dev/null 2>&1; then
  PLAYER="paplay"; PLAYER_NAME="paplay"
elif command -v pw-play >/dev/null 2>&1; then
  PLAYER="pw-play"; PLAYER_NAME="pw-play"
elif command -v play >/dev/null 2>&1; then
  PLAYER="play"; PLAYER_NAME="sox play"
elif command -v ffplay >/dev/null 2>&1; then
  PLAYER="ffplay -nodisp -autoexit -loglevel quiet"; PLAYER_NAME="ffplay"
elif command -v cvlc >/dev/null 2>&1; then
  PLAYER="cvlc --play-and-exit"; PLAYER_NAME="cvlc"
fi

# ─── mode: cannot build WAVs, or preview forced, or no player → the
#     ASCII oscilloscope audition; otherwise the real thing ──────────
if [ "$probe_ok" != "x" ]; then
  echo "audition-sounds.sh needs HOST bash to build the WAVs (this shell's printf has no -v)."
  echo "Showing the ASCII oscilloscope for each sound instead:"
  for s in $SOUNDS; do
    echo "── sound-$s"
    bash "sound-$s.sh" --preview $SEED_ARGS
  done
  echo "audition done (preview mode)"
elif [ "$FORCE_PREVIEW" -eq 1 ]; then
  for s in $SOUNDS; do
    echo "── sound-$s"
    bash "sound-$s.sh" --preview $SEED_ARGS
  done
  echo "audition done (preview mode)"
elif [ "$PLAYER" = "" ]; then
  echo "no audio player found (tried aplay paplay pw-play play ffplay cvlc) —"
  echo "showing the ASCII oscilloscope for each sound instead:"
  for s in $SOUNDS; do
    echo "── sound-$s"
    bash "sound-$s.sh" --preview $SEED_ARGS
  done
  echo "audition done (preview mode)"
else
  if [ "$SEED_ARGS" = "" ]; then SEED_LABEL="default"; else SEED_LABEL=${SEED_ARGS#--seed }; fi
  echo "auditioning: $SOUNDS"
  echo "player: $PLAYER_NAME   seed: $SEED_LABEL"
  echo
  for s in $SOUNDS; do
    # build the wav FIRST so the sound starts the instant its name is
    # echoed (generating treasure's ~10k samples takes a moment)
    wav="/tmp/mimecroft-sound-$s.wav"
    bash "sound-$s.sh" $SEED_ARGS > "$wav"
    r=1
    while [ "$r" -le "$REPEAT" ]; do
      echo "── sound-$s"
      $PLAYER "$wav" >/dev/null 2>&1
      if [ "$?" -ne 0 ]; then
        echo "   (player failed — no sound device? falling back to the ASCII scope)"
        bash "sound-$s.sh" --preview $SEED_ARGS
        r=$REPEAT
      fi
      r=$(( r + 1 ))
    done
    sleep 0.15
  done
  echo "audition done"
fi
