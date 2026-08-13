#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# read-texture.sh — read a texture .tsv (as emitted by
# `texture-*.sh --tsv`) and re-render it as an ANSI shade preview.
# Doubles as the reference reading pattern for mimecroft.sh-style
# scripts that want textured blocks.
#
#   bash texture-grass.sh --tsv > /home/grass.tsv
#   bash read-texture.sh /home/grass.tsv
#
# Works in host bash, the real-bash wasm AND jtsh's transpiled bash.
# The transpiled shell only has SOME reliable string ops: ${s%%TAB*}
# (text before the first tab) and ${s#?} (drop one char) — ${s#*TAB}
# and comma parsing are greedy, ${#s} and IFS word-splitting are
# broken — so the format is pure tab-separated NUMBERS and fields are
# consumed with a probe loop (drop chars until the first char is a
# tab, then drop the tab). No substring reads, no length ops.
#
# Format (3 numbers per pixel — R, G, B):
#   #texture<TAB>NAME<TAB>SIZExSIZE<TAB>seed<TAB>SEED<TAB>
#   R<TAB>G<TAB>B<TAB>…<TAB>R<TAB>G<TAB>B<TAB>   (SIZE rows of
#   …                                             SIZE pixels, trailing
#                                                 tab before each
#                                                 row's newline)
# ─────────────────────────────────────────────────────────────────────

SHADE=" .:-=+*#%@"

# consume one tab-terminated field of the global $s (drop its chars
# until the first char is a tab, then drop the tab too)
strip_field() {
  sf_done=0
  while [ "$sf_done" -eq 0 ]; do
    sf_probe=${s%%	*}
    if [ "$sf_probe" = "" ]; then
      sf_done=1
      s=${s#?}
    else
      s=${s#?}
    fi
  done
}

# read one field of $s into $f, consuming it
read_field() {
  f=${s%%	*}
  strip_field
}

# map r/g/b to a shade glyph
glyph() {
  lum=$(( (r * 3 + g * 6 + b) / 10 ))
  lvl=$(( lum * 9 / 255 ))
  gph=${SHADE:$lvl:1}
}

# ─── main ───────────────────────────────────────────────────────────
if [ "$1" = "" ]; then
  echo "usage: bash read-texture.sh texture.tsv" >&2
  exit 1
fi
s=$(cat "$1")
if [ "$s" = "" ]; then
  echo "read-texture: empty input ($1)" >&2
  exit 1
fi

# header: drop #texture and NAME, grab SIZExSIZE, drop the rest
strip_field
strip_field
sz=${s%%	*}
size=${sz%%x*}
strip_field
strip_field
strip_field
s=${s#?}    # the header line's newline

# SIZE rows of SIZE pixels (3 tab-separated numbers each)
row=0
while [ "$row" -lt "$size" ]; do
  line=""
  col=0
  while [ "$col" -lt "$size" ]; do
    read_field
    r=$f
    read_field
    g=$f
    read_field
    b=$f
    glyph
    line="$line$gph"
    col=$(( col + 1 ))
  done
  echo "$line"
  s=${s#?}   # the row's newline
  row=$(( row + 1 ))
done
