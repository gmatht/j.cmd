#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# make-textures.sh — batch texture generator.
#
#   bash make-textures.sh                 PNG mode (HOST bash only):
#                                         PPMs → PNGs → 2×2 seam checks
#                                         → contact sheet, in CWD.
#   bash make-textures.sh --tsv [DIR]     TSV mode (works ANYWHERE —
#                                         even jtsh's transpiled bash):
#                                         writes texture-*.tsv into DIR
#                                         (default: current dir; use
#                                         /home or /tmp — /examples is
#                                         read-only).
#
# PNG mode needs real bash (printf -v for the PPM bytes) and
# ImageMagick (convert/montage). No `exit` anywhere: the transpiled
# shell's exit kills the whole session.
# ─────────────────────────────────────────────────────────────────────

# ─── TSV mode: pure text, no printf -v, works in the transpiled shell
if [ "$1" = "--tsv" ]; then
  OUTDIR=$2
  if [ "$OUTDIR" = "" ]; then OUTDIR=.; fi
  echo "writing texture-*.tsv to $OUTDIR"
  # explicit list — glob expansion is unreliable in the transpiled shell
  for t in wood grass stone brick leaves sandstone water dirt chest; do
    bash "texture-$t.sh" --tsv > "$OUTDIR/texture-$t.tsv"
    echo "  texture-$t.tsv"
  done
  echo "wrote 9 tsv files to $OUTDIR"
else
  # ─── PNG mode (host only) ────────────────────────────────────────
  # the transpiled sh2 printf (and external printfs) have no -v — the
  # probe sets probe_ok in THIS shell (no command substitution: a
  # subshell would lose it; no 2>&1: the transpiled redirect layer
  # mangles it into a file named "&1")
  printf -v probe_ok 'x' 2>/dev/null > /dev/null
  if [ "$probe_ok" != "x" ]; then
    echo "make-textures.sh (PNG mode) needs HOST bash — this shell's printf can't emit PPM bytes."
    echo "From the repo root on a real machine:  bash examples/textures/make-textures.sh"
    echo "(in this shell, use:  bash make-textures.sh --tsv /home)"
  else
    if ! command -v convert > /dev/null; then
      echo "ImageMagick 'convert' not found — nothing to build (PPM/PNG output needs host bash + ImageMagick)."
    else
      cd "$(dirname "$0")"

      TEX_SEED=${1:-20240812}
      echo "seed $TEX_SEED — generating PPM files..."
      for f in texture-*.sh; do
        t=${f#texture-}
        t=${t%.sh}
        TEX_SEED=$TEX_SEED bash "$f" > "texture-$t.ppm"
      done

      echo "converting to PNG + seam checks + contact sheet..."
      for t in wood grass stone brick leaves sandstone water dirt; do
        convert "texture-$t.ppm" "texture-$t.png"
        # 2×2 tiling — a seamless texture shows no joins in the middle
        montage "texture-$t.png" "texture-$t.png" "texture-$t.png" "texture-$t.png" \
          -tile 2x2 -geometry +0+0 -background black "seam-$t.png"
      done
      # the treasure chest is a one-shot picture, not a tile — convert
      # it for the sheet but skip the seam check
      convert "texture-chest.ppm" "texture-chest.png"
      montage texture-wood.png texture-grass.png texture-stone.png texture-brick.png \
        texture-leaves.png texture-sandstone.png texture-water.png texture-dirt.png texture-chest.png \
        -tile 5x2 -geometry +6+6 -background "#1c1c1c" texture-sheet.png
      echo "wrote: texture-{wood,grass,stone,brick,leaves,sandstone,water,dirt}.{ppm,png}  seam-{wood,grass,stone}.png  texture-sheet.png"
    fi
  fi
fi
