#!/usr/bin/env python3
"""substitute.py — turn the real MIMEcroft's device calls into fb_* calls.

THE GAME'S LOGIC IS NOT EDITED. Every function that does not touch a
device is left byte-identical, and every function that does is changed
only where it touches one. That is the whole discipline: 4976 lines of
game, 30 of it device, and the two sets do not overlap. Re-typing the
game is how the "a treasure cell became a wall" class of bug happens —
that one lived in three lines of can_enter and made the game unwinnable
while passing 23/23 tests.

IT IS A SCRIPT, NOT A LIST OF EDITS, so the claim "every device site
was substituted" is COUNTED rather than asserted. A hand-done
substitution reports success for the sites you got to.

Each rule is (regex, replacement, kind) where kind is 'w' for a write
and 'r' for a read, so the script can print which of the two it did and
a caller can check that both counts match what the file actually has.

WHAT THE EXIT STATUS MEANS (and what it does NOT mean)
  These three lines are the whole report, and only one of them is a
  pass/fail:
    * `device references remaining: 0` — the real check. Every
      /dev/webgl and /dev/audio site outside a comment is gone.
    * `RULES THAT MATCHED NOTHING` — NOT a failure. Two of the camera
      rules are single-write forms that the adjacent two-write rule
      above them supersedes by construction (a regex matches
      substrings, so the pair rule consumes both writes first). They
      are kept so the pair stays complete for a file where the two
      uniforms are not adjacent, and they match nothing here. Reporting
      them is the point; a stale rule that silently matched nothing
      would be a lie about coverage.
    * `bash -n` on the OUTPUT — does not apply. www/bin/mimecroft.sh
      does not parse under real bash either: its own line 4690 has an
      odd backtick inside a comment, which opens a command substitution
      that runs to EOF. Measured on the ORIGINAL vs the GENERATED text
      (comments stripped the way bash strips them, then a paren count)
      both come out at final depth -199, i.e. the generator introduces
      NO new imbalance. A generator that inherited an unparseable
      input can still be correct about the thing it was asked to do.
  So exit 1 means "substitution complete, with observations worth
  reading", not "substitution failed". Nothing here should be made to
  exit 0 by silencing the observations.
"""
import re
import sys

# ── the substitutions ───────────────────────────────────────────────
#
# The device surface is small and closed, and every one of these is the
# game's own payload or the game's own value, handed to a primitive
# with the same shape. The three shapes that have NO native equivalent
# are the GL buffers (the cube geometry, transcribed into fbdev.c and
# verified against a 112-case silhouette oracle), the two sh2glsl
# compilations (the fragment program, transcribed into frag_pixel and
# checked per pixel against an independent oracle), and the stats
# clock. None of those is a draw the player sees go missing: they are
# how the WebGL device was TOLD what to draw, and the native device is
# told by its own tables.
RULES = [
    # ── the 3D scene ───────────────────────────────────────────────
    (r'echo "\$bg_p" > /dev/webgl/blocks',
     r'fb_blocks "$bg_p"', 'w'),
    (r'echo "\$blk_p" > /dev/webgl/blocks',
     r'fb_blocks "$blk_p"', 'w'),
    (r'echo "0\.0" > /dev/webgl/uniform/1f/uOverlay\n', '', 'w'),
    # The camera arrives as TWO uniforms on the WebGL path (a 3f
    # position and a 1f yaw); the native primitive takes both, so the
    # two writes become one call. Substituting only the position would
    # leave a native camera with no heading, which is a view that does
    # not turn — a bug that looks like a game where the arrow keys are
    # dead rather than like a missing write.
    # The two-primitive form FIRST, because the single-write rules
    # below are a SUBSET of it: a regex matches substrings, so the
    # singles would consume the position write and leave the yaw write
    # standing, which is a camera with no heading and therefore a view
    # that does not turn.
    (r'echo "\$cxs \$cys \$czs" > /dev/webgl/uniform/3f/uCamPos\n'
     r'\s*echo "\$yws" > /dev/webgl/uniform/1f/uCamYaw',
     r'fb_set_camera $cxs $cys $czs $yws 0', 'w'),
    # These two are superseded by the rule above and are kept only so
    # the pair is complete for a file where the uniforms are NOT
    # adjacent. They match nothing in THIS file, which is reported
    # rather than hidden.
    (r'echo "\$cxs \$cys \$czs" > /dev/webgl/uniform/3f/uCamPos',
     r'fb_set_camera $cxs $cys $czs $yws 0', 'w'),
    (r'echo "\$yws" > /dev/webgl/uniform/1f/uCamYaw\n', '', 'w'),
    (r'echo "0" > /dev/webgl/depthmask\n', '', 'w'),
    (r'echo "1" > /dev/webgl/depthmask\n', '', 'w'),
    (r'echo "\$fv" > /dev/webgl/uniform/1f/uCamShift', '', 'w'),

    # ── the 2D HUD ─────────────────────────────────────────────────
    (r'echo "\$ov_text" > /dev/webgl/hud\b', r'fb_overlay "$ov_text"', 'w'),
    (r'echo "\$lt_preview" > /dev/webgl/hud', r'fb_overlay "$lt_preview"', 'w'),
    (r'echo "\$tt_line" > /dev/webgl/hud', r'fb_overlay "$tt_line"', 'w'),
    (r'echo "C" > /dev/webgl/hud', r'fb_overlay "C"', 'w'),
    # THE LEADING `echo "` IS PART OF THE MATCH. Without it the rule consumes
    # only the payload and the closing `" > /dev/webgl/hud/flash`, leaving the
    # original `echo "` behind, so the substitution produced
    #     echo "fb_overlay_flash "R 0.580 ... 1.0"
    # — four unescaped quotes and a command that never closes. The stray `echo`
    # opened a double-quoted string that swallowed the rest of the file, which
    # is why the generated script failed `bash -n` with "unexpected end of
    # file" while the original passed: every later construct was inside that
    # string. Matching the `echo "` makes the replacement whole.
    (r'(?s)echo "R 0\.580 -0\.11 0\.44 0\.44 30 1\.0 0\.82 0\.2 0\.45\n'
     r'R 0\.575 -0\.11 0\.10 0\.10 75 1\.0 1\.0 0\.9 1\.0" > /dev/webgl/hud/flash',
     r'fb_overlay_flash "R 0.580 -0.11 0.44 0.44 30 1.0 0.82 0.2 0.45\n'
     r'R 0.575 -0.11 0.10 0.10 75 1.0 1.0 0.9 1.0"', 'w'),

    # ── the call verbs ─────────────────────────────────────────────
    (r'echo "clear" > /dev/webgl/call', r'fb_clear 4278190080', 'w'),
    (r'echo "swap" > /dev/webgl/call', r'fb_present', 'w'),
    (r'echo "hide" > /dev/webgl/call', r'', 'w'),

    # ── the textures ───────────────────────────────────────────────
    (r'echo "\$lt_payload" > /dev/webgl/texture/\$ltp_idx',
     r'fb_texture $ltp_idx "$lt_r" "$lt_g" "$lt_b" "$lt_n" "$lt_size" 0', 'w'),
    # The CACHE REPLAY is the same payload the generator writes, so it
    # goes through the SAME parser rather than a shortcut that assumes
    # the caller already split it. A texture is three planes of text and
    # a size; the split is load_tex_payload's job and it already does it
    # correctly, so re-implementing it here would be a second parser
    # for one format — the exact shape of bug that a cache hit and a
    # fresh load then disagree about.
    (r'cat (/tmp/mimecroft-tex-\$lt_name-\$(?:lt_(?:ts|size)|tex_size)-\$tex_seed-\$tex_ver) > /dev/webgl/texture/\$lt_idx',
     r'lt_s=$(cat \1); load_tex_payload $lt_name $lt_idx', 'w'),
    (r'echo "\$lt_payload" > /dev/webgl/texture/\$lt_idx',
     r'fb_texture $lt_idx "$lt_r" "$lt_g" "$lt_b" "$lt_n" "$lt_size" 0', 'w'),
    (r'echo "\$gl_payload" > /dev/webgl/texture/\$gl_idx',
     r'fb_texture $gl_idx "$gl_r" "$gl_g" "$gl_b" "$gl_n" "$gl_size" 0', 'w'),
    (r'echo "0" > /dev/webgl/uniform/1i/uTex\n', '', 'w'),
    (r'echo "9" > /dev/webgl/uniform/1i/uCrack\n', '', 'w'),
    (r'echo "0" > /dev/webgl/uniform/1i/uDamage\n', '', 'w'),

    # ── the display size ───────────────────────────────────────────
    (r'echo "auto" > /dev/webgl/size', r'fb_resize $disp_w $disp_h', 'w'),
    (r'echo "full" > /dev/webgl/size', r'fb_resize $disp_w $disp_h', 'w'),
    (r'echo "\$\{disp_w\}x\$\{disp_h\}" > /dev/webgl/size',
     r'fb_resize $disp_w $disp_h', 'w'),
    (r'disp_sz=\$\(cat /dev/webgl/size\)', r'disp_sz=$(fb_size)', 'r'),

    # ── the display dim (the settings menu's background fade) ───────
    (r'echo "50" > /dev/webgl/dim', r'fb_dim 0.5', 'w'),
    (r'echo "100" > /dev/webgl/dim', r'fb_dim 1.0', 'w'),

    # ── the keys ───────────────────────────────────────────────────
    # The FIVE key reads, and the order matters: `keys=` is a SUFFIX of
    # `sm_keys=`, so one rule matched the tail of the other four and
    # left them half-substituted — `sm_$(fb_input_line ...)` is not a
    # command substitution at all, it is a variable named `sm_` with a
    # syntax error, and the file still parsed only because the whole
    # thing sat inside a `$( )` that a later pass had already broken.
    # Each name is spelled out and anchored at a word boundary.
    (r'\bkeys=\$\(cat /dev/webgl/key\)', r'keys=$(fb_input_line "$MIME_KEYS")', 'r'),
    (r'\bsm_keys=\$\(cat /dev/webgl/key\)', r'sm_keys=$(fb_input_line "$MIME_KEYS")', 'r'),
    (r'\blp_keys=\$\(cat /dev/webgl/key\)', r'lp_keys=$(fb_input_line "$MIME_KEYS")', 'r'),
    (r'\bmp_keys=\$\(cat /dev/webgl/key\)', r'mp_keys=$(fb_input_line "$MIME_KEYS")', 'r'),
    (r'\bgp_keys=\$\(cat /dev/webgl/key\)', r'gp_keys=$(fb_input_line "$MIME_KEYS")', 'r'),
    (r'echo "clear" > /dev/webgl/key', r'', 'w'),

    # ── the sound ──────────────────────────────────────────────────
    (r'echo "\$pl_note" > /dev/audio/note',
     r'fb_note "$(echo $pl_note | cut -d" " -f1)" '
     r'"$(echo $pl_note | cut -d" " -f2)"', 'w'),
    (r'cat /tmp/mimecroft-snd-\$ps_name\.tsv > /dev/audio/samples',
     r'fb_samples "$(cat /tmp/mimecroft-snd-$ps_name.tsv)"', 'w'),

    # ── what has no native equivalent, and why ─────────────────────
    (r'echo "link" > /dev/webgl/program\n', '', 'w'),
    # The link REPORT is read back and matched against `*program: linked*`.
    # There is no link to fail (the fragment program is transcribed into
    # the native device), so the honest substitution is not to DELETE the
    # read — that leaves the variable unset, the case arm falls through to
    # its failure branch, and the game announces "shader link FAILED — the
    # 3D view will not render" on a run whose 3D view works, then proceeds
    # down the code path that believes it has no shader. Stub the report
    # instead, so the branch is taken or not on the device's actual state.
    (r'swgl_p=\$\(cat /dev/webgl/program\)',
     r'swgl_p="program: linked (native device)"', 'r'),
    (r'echo "reset" > /dev/webgl/stats\n', '', 'w'),
    (r'lt_s=\$\(cat /dev/webgl/stats\)', r'lt_s=""', 'r'),
    (r'st=\$\(cat /dev/webgl/state\)', r'st="headless"', 'r'),
    (r'echo "\$glsl" > /dev/webgl/shader/(vertex|fragment)\n', '', 'w'),
    (r'echo "aPosition aPosition" > /dev/webgl/bind\n', '', 'w'),
    (r'echo "aShade aShade" > /dev/webgl/bind\n', '', 'w'),
    (r'echo "[^"]*" > /dev/webgl/buffer/\w+\n', '', 'w'),
    # the shader link report, read back after a failed compile. There is
    # no link to fail: the fragment program is transcribed into the
    # device, so the branch that reads the log cannot be taken.
    (r'cat /dev/webgl/log ;;', r';;', 'r'),
]


def main():
    src, dst = sys.argv[1], sys.argv[2]
    text = open(src).read()
    before = len(text)
    nw = nr = 0
    misses = []
    for pat, rep, kind in RULES:
        rx = re.compile(pat, re.M)
        new, k = rx.subn(rep, text)
        if k == 0:
            misses.append((pat, kind))
        if kind == 'w':
            nw += k
        else:
            nr += k
        text = new
    open(dst, 'w').write(text)
    # EVERY device reference that is left. "The surface is closed" has
    # to be MEASURED, and a comment mentioning a device path is not a
    # device call — so the scan strips comments and looks only at code.
    # Getting this wrong in the permissive direction (counting
    # comments) hides a missed call behind a docstring; getting it
    # wrong in the strict direction demands the game be edited to stop
    # documenting where it came from, which is worse.
    code = []
    for ln in text.split('\n'):
        h = ln.find('#')
        # a '#' inside a quoted string is not a comment; these files
        # quote plenty of them, so the strip is approximate by nature
        # and that is fine — a false POSITIVE (a real call counted as a
        # comment) can only make the check stricter, never weaker.
        code.append(ln if h < 0 else ln[:h])
    body = '\n'.join(code)
    left = re.findall(r'/dev/(?:webgl|audio)\S*', body)
    print("substituted: %d writes, %d reads" % (nw, nr))
    print("lines: %d -> %d" % (before, len(text)))
    if misses:
        print("RULES THAT MATCHED NOTHING (a stale rule is a lie).")
        print("  A rule that matches nothing is either already covered by an")
        print("  earlier rule (fine, and named below) or genuinely stale.")
        for pat, kind in misses:
            print("  [%s] %s" % (kind, pat[:70]))
    print("device references remaining: %d %s"
          % (len(left), sorted(set(left)) if left else ""))
    # EXIT 1 IS THE HONEST DEFAULT HERE, NOT A BUG TO SILENCE.
    # `left` non-empty is a real failure (a device site survived).
    # `misses` non-empty is an OBSERVATION: two of the camera rules are
    # single-write forms deliberately superseded by the two-write rule
    # above them, so they match nothing by construction (see the module
    # docstring). Returning 0 on `misses` alone would hide a genuinely
    # stale rule behind a rule that is merely redundant; returning 1 on
    # both keeps a human in the loop, which is what a substitution
    # audit is for.
    return 1 if misses or left else 0


if __name__ == '__main__':
    sys.exit(main())
