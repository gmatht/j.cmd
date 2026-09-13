#!/usr/bin/env bash
# ─── 05 — a param whose ONLY use is inside an array-index name ───────
# Class: dead-code / use analysis. Status: OPEN.
#
# The use of a variable inside a rendered array-index name (`arr[$v]`)
# is invisible to the frontend's liveness analysis, so
#   * the assignment is dropped as dead code, and
#   * the remaining arguments are RENUMBERED, so the values shift.
#
# Minimal shape (called with three args, so the renumbering is visible):
#   store 10 20 30   → tpx[1]=10, tpz[1]=20
#   store 11 21 31   → tpx[2]=11, tpz[2]=21
# Every array element must be recorded, exactly as bash does.
set -u

tpx=(); tpz=()

set_pos() { sp_i=$1; sp_x=$2; sp_z=$3
  tpx[$sp_i]=$sp_x
  tpz[$sp_i]=$sp_z
}

set_pos 1 10 20
set_pos 2 11 21

echo "tpx[1]=${tpx[1]} tpz[1]=${tpz[1]}"
echo "tpx[2]=${tpx[2]} tpz[2]=${tpz[2]}"
echo "all=${tpx[*]}|${tpz[*]}"
