#!/usr/bin/env bash
# ── FIXED (guard): a SINGLE-QUOTED string must stay verbatim ──────
# 'verbatim $b' is literal text. The post-lift interpolation pass used to
# rewrite every string containing "$b" into a JS template, so a quoted
# payload (the mimecroft fragment shader staging `putb $b`) lost its
# literal `$b`. The emitter now marks quoted literals opaque (sh2.lit)
# and the passes skip them.
# Expected: verbatim $b
b="SECRET"
emit() { echo 'verbatim $b'; }
emit
