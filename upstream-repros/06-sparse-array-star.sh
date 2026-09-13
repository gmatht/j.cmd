#!/usr/bin/env bash
# ─── 06 — `${a[*]}` must skip indices that were never assigned ────────
# Class: array expansion. Status: OPEN/FIXED per run.
#
# bash expands only the elements that EXIST: a hole (an index that was
# never assigned) is skipped, it does not contribute an empty field. A
# dense rendering of the holes shows up as extra spaces.
a=()
a[1]=x
a[2]=y
echo "star=[${a[*]}]"
echo "at=[${a[@]}]"
echo "count=${#a[@]}"
