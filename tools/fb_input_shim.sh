#!/bin/bash
# fb_input_shim.sh — a real-bash stand-in for the fbinput device
# (sh2perl/runtime/fbinput.c), used only by mimecroft-fb-equivalence.sh.
#
# WHY IT EXISTS
#   The game now reads `rk=$(fb_input_line)` — a DEVICE call, which real
#   bash cannot make. The equivalence harness needs a real-bash run of
#   the same script, so it installs this shim: both sides then answer
#   "the next key from $FB_KEYS" under the same rules, and any
#   difference in the rendered frame is the TRANSPILER's rather than
#   the shim's.
#
# THE RULES, from fbinput.c
#   * one key per line, consumed in order;
#   * a BLANK line is a real key — the game reads "" as "no key", so
#     blank lines are how a scripted run paces itself, and swallowing
#     one would silently change which frames a key lands on;
#   * a key file whose last line has NO trailing newline still yields
#     that key, exactly once (see below);
#   * end of file is NOT final: a key appended later is still seen
#     (the device re-reads, it does not latch EOF). This is what lets a
#     run queue keys progressively.
#
# AN UNTERMINATED LAST LINE IS CONSUMED (this was a bug worth 5 of the
# suite's cases). `printf '%s\n' "$keys"` ends the key file with a
# newline, but the harness case "q q q q q w" whose LAST key is
# followed by another key... produces a file ending in "w\n" only when
# the case is written with a trailing newline. When it is not, the
# device returns the partial tail as a key and marks the queue SPENT;
# this shim used to return it again on every later call, so a 6-key
# script drove the game with 9 keys — the player walked three extra
# steps and the two sides disagreed about a game that was, in fact,
# identical. The device's kf_next() sets KF_eof on the read(2) that
# hits EOF, which ends the tail; the sidecar must record the same
# thing, and it does so by recording the position PAST the tail.
#
# THE POSITION IS KEPT IN A SIDECAR FILE, not a shell variable.
# A command substitution runs in a SUBSHELL, so an assignment to a
# variable inside `fb_input_line` dies with the subshell and the next
# call starts from zero again — every call returned the FIRST key, and
# a 4-key script moved the player once. The C device keeps its position
# in the process, so it never had this problem; only a shell
# reimplementation does.
#
# Cost is irrelevant here — this is a reference, not the game loop. The
# point of the real device is that it does NOT fork; a shim that forks
# is fine precisely because it only ever runs in the reference.

fb_input_line() {
  # The queue is the first ARGUMENT, as the device takes it: a game
  # keeps it in a shell variable, and an `export` never reaches a C
  # device (the emitted C assigns a variable and never calls setenv).
  local keyfile="${1:-${FB_KEYS:-}}"
  # The sidecar path is computed HERE, not at definition time. The shim
  # is inserted ABOVE the game's KEYS assignment, so a path expanded
  # when the function was DEFINED would name a file from whatever
  # FB_KEYS happened to be in the environment -- a different file from
  # the one the harness clears between cases, and therefore a key
  # position leaking from one case into the next. That is exactly the
  # kind of bug that makes a suite pass once and fail later.
  local posfile="${keyfile:-/tmp/mimecroft-keys}.pos"
  if [ -z "$keyfile" ] || [ ! -f "$keyfile" ]; then
    echo ""
    return 0
  fi
  local pos size rest line head
  pos=0
  [ -f "$posfile" ] && pos=$(cat "$posfile")
  case "$pos" in ''|*[!0-9]*) pos=0 ;; esac
  size=$(wc -c < "$keyfile")
  if [ "$size" -le "$pos" ]; then
    echo ""          # nothing new appended yet
    return 0
  fi
  rest=$(tail -c "+$((pos + 1))" "$keyfile")
  if [ "${rest#*$'\n'}" = "$rest" ]; then
    # No newline in the remainder: the tail IS the key. Record the
    # position PAST it, so the queue is spent and the next call sees
    # "nothing appended yet" (""), exactly as the device does after
    # the read that hit EOF. Advancing only to the newline is what
    # made the tail repeat for the rest of the run.
    line=$rest
    echo "$size" > "$posfile"
  else
    line=${rest%%$'\n'*}
    head=${rest%%$'\n'*}
    echo "$((pos + ${#head} + 1))" > "$posfile"
  fi
  echo "$line"
}
