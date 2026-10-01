# MIMEcroft on fb0 — the generated port

`mimecroft-fb0.sh` is the **real** MIMEcroft: all 107 functions and 4,969
lines of `www/bin/mimecroft.sh`, with only its ~30 device-touching lines
rewritten onto the native framebuffer.

## Do not confuse it with MIMEcroft_fb.sh

There are two fb0 ports and they are not the same thing:

| file | lines | functions | what it is |
|---|---|---|---|
| `MIMEcroft_fb.sh` (repo root) | 865 | 10 | a hand-written **partial** port — maze walk to a chest. No combat, enemies, HUD, minimap, sound, textures or menus. Kept as the regression oracle for the 25-case equivalence suite. |
| `tools/fb0/mimecroft-fb0.sh` | 4,969 | 107 | **this one.** The whole game. |

The hand port exists because the equivalence suite diffs a native frame
against a real-bash frame, and it is small enough to reason about; it was
never meant to be the deliverable.

## Regenerating

Never edit `mimecroft-fb0.sh` by hand — it is generated:

    python3 tools/fb_substitute.py www/bin/mimecroft.sh tools/fb0/mimecroft-fb0.sh

The generator rewrites device calls only and leaves every other line
byte-identical, so a re-generation is the review. Its exit code is 1 even
on success; see the module docstring in `fb_substitute.py` for what each
line of its report means and why it is not a failure.

Re-run it after ANY edit to `www/bin/mimecroft.sh`, then rebuild:

    bash-O4 -o /tmp/mimecroft-fb0 tools/fb0/mimecroft-fb0.sh

## Running it

Headless (scripted keys, no window):

    printf 'q\n' > /tmp/keys
    MIME_WINDOW=0 MIME_KEYS=/tmp/keys /tmp/mimecroft-fb0

With a window (needs a display; falls back to RAM+PPM without one):

    /tmp/mimecroft-fb0

There is **no** `MIME_FRAMES` budget and **no** `MIME_OUT` in the real
game — those knobs belong to the hand port's test harness. The original's
only exit paths are `q`, `hp<=0`, or EOF on the key file, so drive it with
a key file that ends in `q` unless you mean to play it.

## What is verified, and what is not

Verified by running it: startup, the shader report, all 16 block textures,
the treasure labels and mime banners, per-frame key reads, the render loop,
and a clean `q` exit with the stats block.

**Not** verified: a scored playthrough. Nobody has claimed a treasure or
shot a MIME in this port, and it has no byte-exact oracle — the original
was only made parseable (`bash -n`) recently, and the two are not yet
diffed frame-for-frame. Treat "the whole game is correct on fb0" as an
open question, not a result.
