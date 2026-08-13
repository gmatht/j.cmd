#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# mimecroft-frag.sh — MIMEcroft's fragment shader, AUTHORED IN BASH and
# compiled to GLSL by the sh→GLSL backend (glsl_backend.rs in the
# sh2perl repo; `sh2glsl` command). The game writes this program to
# /tmp at startup (emit_fragment_shader) and compiles it; the generated
# GLSL ES 1.00 fragment shader is loaded into /dev/webgl/shader/fragment.
# __shader-test.mjs assembles the game's INLINE program from
# emit_fragment_shader and asserts it equals this file's code section.
#
# Inputs (bridged by the generator, all ints):
#   frag_x, frag_y   ← int(gl_FragCoord.xy)
#   vcolor_r/g/b     ← int(vColor.rgb * 255.0)   (the vertex shader's
#                      varying — the block colour)
#   tex_r/g/b        ← the sampled block-texture texel (0-255)
#   damage, cr_r/g/a ← the crack-overlay level + texel
# Output: out_buf bytes 0..3 = R, G, B, A  (via `putb N`)
#
# Effects (pure integer arithmetic — GLSL has no strings, the backend
# has no floats):
#   • block texture × colour tint
#   • damage: mix in the crack texture by the damage level
#   • CRT scanline:  every 6th row dims 10%
#   • corruption:    a deterministic hash of the pixel position throws
#                    1 in 97 pixels into red (the evil-MIME glare)
#   • vignette:      corners darken toward the 800×600 frame edge
# ─────────────────────────────────────────────────────────────────────
fx=$((frag_x))
fy=$((frag_y))
r=$((vcolor_r))
g=$((vcolor_g))
b=$((vcolor_b))
r=$((r * tex_r / 255))
g=$((g * tex_g / 255))
b=$((b * tex_b / 255))
if [ "$damage" -gt 0 ]; then
  mix=$((damage * cr_a / 3))
  r=$((r * (255 - mix) / 255 + cr_r * mix / 255))
  g=$((g * (255 - mix) / 255 + cr_g * mix / 255))
  b=$((b * (255 - mix) / 255 + cr_b * mix / 255))
fi
scan=$((fy % 6))
if [ "$scan" -eq 0 ]; then
  r=$((r * 90 / 100))
  g=$((g * 90 / 100))
  b=$((b * 90 / 100))
fi
hash=$((fx * 7 + fy * 13))
corrupt=$((hash % 97))
if [ "$corrupt" -eq 0 ]; then
  r=255
  g=$((g / 2))
  b=$((b / 2))
fi
vx=$((fx - 400))
vy=$((fy - 300))
if [ "$vx" -lt 0 ]; then vx=$((0 - vx)); fi
if [ "$vy" -lt 0 ]; then vy=$((0 - vy)); fi
edge=$((vx + vy))
if [ "$edge" -gt 450 ]; then
  dim=$((edge - 450))
  if [ "$dim" -gt 30 ]; then dim=30; fi
  r=$((r - r * dim / 255))
  g=$((g - g * dim / 255))
  b=$((b - b * dim / 255))
fi
if [ "$r" -lt 0 ]; then r=0; fi
if [ "$g" -lt 0 ]; then g=0; fi
if [ "$b" -lt 0 ]; then b=0; fi
putb $r
putb $g
putb $b
putb 255
