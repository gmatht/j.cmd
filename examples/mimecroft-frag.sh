#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# mimecroft-frag.sh — MIMEcroft's fragment shader, AUTHORED IN BASH and
# compiled to GLSL by the sh→GLSL backend (glsl_backend.rs in the
# sh2perl repo; `sh2glsl` command). The game writes this program to
# /tmp at startup and compiles it; the generated GLSL ES 1.00 fragment
# shader is loaded into /dev/webgl/shader/fragment.
#
# Inputs (bridged by the generator, all ints):
#   frag_x, frag_y   ← int(gl_FragCoord.xy)
#   vcolor_r/g/b     ← int(vColor.rgb * 255.0)   (the vertex shader's
#                      varying — the block colour)
# Output: out_buf bytes 0..3 = R, G, B, A  (via `putb N`)
#
# Effects (pure integer arithmetic — GLSL has no strings, the backend
# has no floats):
#   • CRT scanline:  every 6th row dims 10%
#   • corruption:    a deterministic hash of the pixel position throws
#                    1 in 97 pixels into red (the evil-MIME glare)
#   • vignette:      corners darken toward the frame edge
# ─────────────────────────────────────────────────────────────────────

fx=$((frag_x))
fy=$((frag_y))
r=$((vcolor_r))
g=$((vcolor_g))
b=$((vcolor_b))

# CRT scanline
scan=$((fy % 6))
if [ "$scan" -eq 0 ]; then
  r=$((r * 90 / 100))
  g=$((g * 90 / 100))
  b=$((b * 90 / 100))
fi

# corruption flicker — a hash of the pixel position
hash=$((fx * 7 + fy * 13))
corrupt=$((hash % 97))
if [ "$corrupt" -eq 0 ]; then
  r=255
  g=$((g / 2))
  b=$((b / 2))
fi

# vignette — darken toward the edges of a 240×180 view (multiplicative:
# r - r·dim/255 scales toward dark, so dark pixels never clip to black;
# r·dim ≤ 255·40 stays inside the mediump-int proof)
vx=$((fx - 120))
vy=$((fy - 90))
if [ "$vx" -lt 0 ]; then vx=$((0 - vx)); fi
if [ "$vy" -lt 0 ]; then vy=$((0 - vy)); fi
edge=$((vx + vy))
if [ "$edge" -gt 150 ]; then
  dim=$((edge - 150))
  if [ "$dim" -gt 40 ]; then dim=40; fi
  r=$((r - r * dim / 255))
  g=$((g - g * dim / 255))
  b=$((b - b * dim / 255))
fi

# clamp
if [ "$r" -lt 0 ]; then r=0; fi
if [ "$g" -lt 0 ]; then g=0; fi
if [ "$b" -lt 0 ]; then b=0; fi

putb $r
putb $g
putb $b
putb 255
