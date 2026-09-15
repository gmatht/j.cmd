#!/usr/bin/env bash
# ─── 08 — redirect target from an UNQUOTED command substitution ───
# Class: redirect-word expansion / ambiguity detection. Status: OPEN.
#
# Found while building mimecroft: a 130-byte junk file appeared in the
# repo root, named after a fragment of shader source —
#
#   $(echo "scale=4; 0.0 - $relz + 0.0" | bc)\n  if [ "$(echo ...)" = "1" ]; \
#     then w=0.0001; fi|
#
# with contents `   bc)| bc)` (the stdout of two `bc` runs). The name is
# a bash float capture glued to the shell-syntax form of a GLSL clamp
# that www/bin/mimecroft.sh injects at line 1307:
#
#   glsl=${glsl/g_w = …;/g_w = …; if (g_w < 0.0001) g_w = 0.0001;}
#
# The `\n` in it is a LITERAL backslash-n, never a real newline — the
# fingerprint of this text being re-escaped at least twice on its way
# into a filename. The spaces make it many words.
#
# bash's rule for a redirect target built from a command substitution is
# exact, and word splitting is the whole point:
#
#   * ONE resulting word  → the redirect happens (file created)
#   * ZERO or MANY words  → `ambiguous redirect`, status 1, NO file
#
# The runtime gets this wrong in both directions, because the emitter
# passes captureWords()'s ARRAY straight to fs.writeFile as the path:
#
#   await sh2.fs.writeFile(
#     await sh2.captureWords(() => sh2.builtin("echo", ["alpha"])),
#     "hi" + "\n")
#
#   bash=one-word:[hi]  transpiled: `bash: alpha: path.startsWith is not a function`
#   bash=two-word:rejected  transpiled: creates a file named `alpha`
#
# So a single word should be UNWRAPPED, and 0-or-many words should raise
# `ambiguous redirect` + status 1 without touching the filesystem. This
# is the mechanism that let a multi-word expansion write a file named
# after shader source instead of failing loudly.
#
# Acceptance rule (this repo): the transpiled shell prints what real bash
# prints.   node ../run-upstream-repros.mjs 08

W=/tmp/u08; rm -rf $W; mkdir -p $W; cd $W

# ── 1. one word: bash creates the file, so must we ──
echo hi > $(echo onepiece)
echo "one-word: [$(cat onepiece 2>/dev/null)]"

# ── 2. two words: bash: ambiguous redirect (status 1), NO file ──
rm -f alpha beta
if echo hi > $(echo alpha beta) 2>/dev/null; then
  echo "two-word: accepted"
else
  echo "two-word: rejected"
fi
echo "two-word-files: [$(ls -A | sort | tr '\n' ' ')]"

# ── 3. empty expansion: bash: ambiguous redirect (status 1), NO file ──
rm -rf ./* 2>/dev/null
if echo hi > $(true) 2>/dev/null; then
  echo "zero-word: accepted"
else
  echo "zero-word: rejected"
fi
echo "zero-word-files: [$(ls -A | sort | tr '\n' ' ')]"

# ── 4. the junk-name SHAPE: embedded spaces + a literal \n → many words.
#    bash rejects it outright, so bash never wrote that file. ──
rm -rf ./* 2>/dev/null
if echo hi > $(printf 'a\nb c\n') 2>/dev/null; then
  echo "junk-shape: accepted"
else
  echo "junk-shape: rejected"
fi
echo "junk-shape-files: [$(ls -A | sort | tr '\n' ' ')]"

cd /; rm -rf $W
