# Screenshot Similarity: settings screen vs. game frame 1

How similar are the MIMEcroft settings screen and the game's first
rendered frame (before any movement)? This document records the
pixel-level comparison.

## How the screenshots were taken

- Real browser (Playwright + Chromium, SwiftShader WebGL) loading
  `http://127.0.0.1:8060/www/` and running `MIMEcroft.sh` in the
  terminal.
- Canvas pixels captured with `gl.readPixels` (800×600) plus a
  `canvas.toDataURL("image/png")` snapshot:
  - **settings-A / settings-B** — the pre-game settings menu, two
    captures 2 s apart (the menu is idle; textures already loaded).
  - **frame1-A / frame1-B** — the game's first rendered frame: SPACE
    pressed to dismiss the menu, waited until the terminal prints
    `ready.` + 2 s (so the game loop has rendered frame 1), two
    captures 0.5 s apart with **no movement** (the view is cached, so
    an idle game shows the same retained frame).
- Similarity metric: per-pixel RGBA equality. `identical%` = exact
  matches; `near%` = matches within a 30-point RGB Manhattan distance.
  A 8×6 grid of 100×100-pixel regions gives per-region identical %.

Screenshot files: `tmp/shots6/settings-A.png`, `settings-B.png`,
`frame1-A.png`, `frame1-B.png` (raw pixel dumps in the matching
`*.json`). Raw numbers: `tmp/shots6/all-similarity.json`.

## Results

| comparison | identical | near | notes |
|---|---|---|---|
| settings-A vs settings-B | **100.00 %** | 100.00 % | every one of the 48 regions = 100 % |
| frame1-A vs frame1-B | **99.99 %** | 99.99 % | rows 4–5 cols 4–5 at 99.8 % only (HUD FPS digit / cursor) |
| settings-A vs frame1-A | **1.11 %** | 1.43 % | only the dark-background regions overlap |

### How similar are the settings screenshots?

**100 % identical.** The settings menu is a static composition (menu
text, texture thumbnails, HUD) — two captures taken 2 s apart are
byte-identical in every pixel. It is fully reproducible.

### How similar are the frame-1 screenshots?

**99.99 % identical.** The first game frame is also static: the 3D
view is cached (the game re-renders only when the camera or world
changes), so an idle frame 1 is the same frame. The only differing
pixels (0.01 %) are in the bottom-centre region (rows 4–5, cols 4–5)
— the FPS digits on the HUD, which update once per second, and the
terminal cursor.

### Are there parts of the screen that are the same (settings vs. frame 1)?

Almost nothing. Only **1.11 %** of pixels match between the settings
screen and frame 1 — and those are concentrated in the vertical middle
band (regions rows 2–3), where both screens show dark background
pixels. Everything else is different:

- rows 0–1 and 4–5: **0 %** identical — the menu's texture
  thumbnails / header vs. the game's floor/ceiling + HUD do not share
  a single pixel.
- rows 2–3 (middle): 1–7 % — the shared dark backdrop; the menu text
  and the maze walls differ.

So the settings screen and the game's frame 1 are **essentially
different images**, as they should be: SPACE visibly switches from the
menu to the 3D maze view.

## Do the metrics look "very similar"?

No — the cross-pair comparison is the outlier:

| | identical % |
|---|---|
| settings vs settings | 100.00 |
| frame 1 vs frame 1 | 99.99 |
| **settings vs frame 1** | **1.11** |

Settings-vs-frame-1 is ~90× lower than the same-scene pairs. The game
is not "stuck on the settings screen": frame 1 is a genuinely
different image (the maze view renders after SPACE). The earlier
look-alike measurement (~84 % identical) was a capture-timing
artifact — it compared the settings menu against the **texture-loading
screen** (the dark loading frame between the menu and the game), not
the real frame 1. Waiting for `ready.` before capturing makes the
distinction unambiguous.
