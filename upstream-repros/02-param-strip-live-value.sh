#!/usr/bin/env bash
# ── FIXED (guard): `${v#pat}` strip of a LIFTED variable ──────────
# The strip lowers to sh2.param("#", "v", pat), which the runtime
# resolves from the STORE. A lifted variable never writes its store copy,
# so the strip came back empty. Two fixes: paramLiveValue appends the
# live value (and must run AFTER the lifts, and read the LAST argument),
# and vars named in such strings are excluded from lifting.
# Expected: strip: [cdef]   (a regression here means an empty [])
v="abcdef"
w=${v#??}
echo "strip: [$w]"
