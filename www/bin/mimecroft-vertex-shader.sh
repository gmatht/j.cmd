#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# mimecroft-vertex.sh — MIMEcroft's VERTEX shader, AUTHORED IN BASH and
# compiled to GLSL by the sh→GLSL backend (glsl_backend.rs in the
# sh2perl repo; `sh2glsl --vertex`). The game compiles this program at
# startup and loads the generated GLSL ES 1.00 vertex shader into
# /dev/webgl/shader/vertex.
#
# Inputs (bridged by the generator, all ints, ×1000):
#   ap_x/y/z    ← int(aPosition.xyz * 1000.0)   (±500 = the cube corners)
#   ash_r/g/b   ← int(aShade.rgb * 1000.0)      (450..1000 = face brightness)
#   auv_u/v     ← int(aUv.xy * 1000.0)          (0..1000 = texture coords)
#   ucp_x/y/z   ← int(uCamPos.xyz * 1000.0)     (the PLAYER CELL — world units)
#   ucy_m       ← int(uCamYaw * 1000.0)         (milli-degrees, 0..360000)
#   ucs         ← int(uCamShift * 1000.0)       (milli-NDC — the strafe shift)
#   uop_x/y/z   ← int(uObjPos.xyz * 1000.0)     (block centre, world units)
#   usc_x/y/z   ← int(uScale.xyz * 1000.0)      (1 → 1000; 0.7 → 700; 16 → 16000)
#   ublk_r/g/b  ← int(uBlockColor.rgb * 1000.0) (0..1000 = the block colour)
#   uov         ← int(uOverlay * 1000.0)        (0 or 1000 — HUD overlay)
# Outputs (read back by the generator at the end of main()):
#   vp_x/y/z/w  ← gl_Position (floats, world units — the fake perspective)
#   vc_r/g/b/a  ← int ×1000 → vColor (face brightness × block colour)
#   vu_u/v      ← int ×1000 → vUv (the texture coordinates)
#
# Math (all through the supported `echo "scale=K; …" | bc` float
# captures — the float grammar covers + - * / % ^, parens and the bc
# trig c()/s() → GLSL cos/sin):
#   p  = aPosition * uScale + uObjPos                 (object → world)
#   d  = p - (uCamPos + (0, ½, 0))                    (camera-relative — the
#        eye sits at the PLAYER CELL'S CENTRE, half a block up; the x/z
#        offset is ZERO so a corridor view is centred between its walls —
#        the old +½ put the eye on the cell corner and pushed one wall
#        off-screen)
#   rel = (d.x·cos yaw + d.z·sin yaw, d.y, -d.x·sin yaw + d.z·cos yaw)
#   w  = -rel.z                                       (depth)
#   gl_Position = (rel.x·0.45 + uCamShift·w, rel.y·0.45, w²/64, w) — 50% scale (the whole 16x16 map fits)
#   (uCamShift is a constant screen-x shift: NDC x = rel.x·0.45/w + shift)
# Every bc capture carries a decimal-point literal (the backend's
# float-path gate), every integer expression stays in `$(( ))`, and the
# program is otherwise a faithful transcription of the hand-written
# GLSL it replaces — so the two render identically.
# ─────────────────────────────────────────────────────────────────────

# object-space → world position (floats, world units)
wx=$(echo "scale=4; $ap_x * $usc_x / 1000000.0 + $uop_x / 1000.0" | bc)
wy=$(echo "scale=4; $ap_y * $usc_y / 1000000.0 + $uop_y / 1000.0" | bc)
wz=$(echo "scale=4; $ap_z * $usc_z / 1000000.0 + $uop_z / 1000.0" | bc)

# face brightness × block colour (int, ×1000 — same in both paths)
vc_r=$((ash_r * ublk_r / 1000))
vc_g=$((ash_g * ublk_g / 1000))
vc_b=$((ash_b * ublk_b / 1000))
vc_a=1000

if [ "$uov" -gt 500 ]; then
  # overlay quad: the fragment shader's uOverlay > 0.5 path — flat NDC
  # at the object position (strafe-shifted), untextured
  vp_x=$(echo "scale=4; $wx + $ucs / 1000.0 + 0.0" | bc)
  vp_y=$wy
  vp_z=$(echo "scale=4; $uov * 0.0 - 0.95" | bc)
  vp_w=$(echo "scale=4; $uov * 0.0 + 1.0" | bc)
  vu_u=0
  vu_v=0
else
  # camera at the player cell's CENTRE, half a block up (x/z unshifted —
  # the eye must sit on the corridor centreline, not the cell corner)
  cx=$(echo "scale=4; $ucp_x / 1000.0 + 0.0" | bc)
  cy=$(echo "scale=4; $ucp_y / 1000.0 + 0.5" | bc)
  cz=$(echo "scale=4; $ucp_z / 1000.0 + 0.0" | bc)
  # camera-relative delta
  dx=$(echo "scale=4; $wx - $cx + 0.0" | bc)
  dy=$(echo "scale=4; $wy - $cy + 0.0" | bc)
  dz=$(echo "scale=4; $wz - $cz + 0.0" | bc)
  # yaw (milli-degrees) → radians → cos/sin (bc trig → GLSL cos/sin)
  rad=$(echo "scale=8; $ucy_m * 3.14159265 / 180000.0" | bc)
  c=$(echo "scale=6; c($rad) + 0.0" | bc)
  s=$(echo "scale=6; s($rad) + 0.0" | bc)
  # rotate into view space (yaw 0 → facing -z; the hand shader's rotation)
  relx=$(echo "scale=4; $dx * $c + $dz * $s + 0.0" | bc)
  rely=$dy
  relz=$(echo "scale=4; 0.0 - $dx * $s + $dz * $c + 0.0" | bc)
  w=$(echo "scale=4; 0.0 - $relz + 0.0" | bc)
  # the fake perspective: x/y scaled 0.45 = the 50% map scale (x + the strafe screen-shift
  # uCamShift·w), z = w²/64 (depth-ordered), w = depth
  vp_x=$(echo "scale=4; $relx * 0.45 + $ucs * $w / 1000.0 + 0.0" | bc)
  vp_y=$(echo "scale=4; $rely * 0.45" | bc)
  vp_z=$(echo "scale=4; $w * $w / 64.0" | bc)
  vp_w=$w
  vu_u=$auv_u
  vu_v=$auv_v
fi
