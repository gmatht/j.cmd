# MIMEcroft.sh — A 3D Maze Treasure Hunt Written in Bash

## (Proposal)

A companion piece to [bash-game-vision.md](bash-game-vision.md). The vision
document shows that a real-time 3D game in pure POSIX shell is architecture
sound. This proposal is the specific game that should be built next:
**MIMEcroft.sh** — Minecraft's gameplay, MIME's pathology, and the shell's
filesystem-as-API metaphor, all in one script.

It is a **serious joke**, like its predecessor. The joke: a first-person 3D
treasure hunt, rendered via WebGL, written entirely in bash. The serious
part: almost everything it needs already exists in `sh2runtime` today.

---

## The Concept

You are a lost shell command inside a corrupted filesystem. The maze around
you is made of **data blocks** — coloured chunks of file content. Somewhere
in the depths lie hidden **treasures**: the Great Operating Systems (GNU
Hurd, Linux, FreeBSD, Plan 9, ...) preserved as artifacts. But the
filesystem is infested with **evil MIMEs** — misbehaving content types
(`image/jpeg`, `image/png`, `application/octet-stream`, ...) that hunt you
through the corridors.

Your tools: a gun that fires a **single ray of pure type-checking**.
Shooting a block destroys it (you are mining through the data). Shooting a
MIME destroys it (you are sanitising the input). Find all the treasures
before the MIMEs find you.

```
  find treasures          avoid MIMEs            shoot everything
  ┌──────────┐           ┌────────────┐          ┌──────────────┐
  │ ██ GNU ██ │           │  image/jpeg │          │  pew! pew!   │
  │  Hurd     │           │  /png       │          │  ▓▓ → ░░     │
  └──────────┘           └────────────┘          └──────────────┘
```

The name is the pitch: **MIME** (the worst corner of email) + **Minecraft**
(the game whose entire aesthetic is blocks). The treasures are OSes because
this is, after all, a game about a shell.

---

## Why This Game, Why Now

`bash-game-vision.md` already ships a complete Pong. MIMEcroft is the
natural escalation — it exercises *every* part of the stack that Pong
touched only lightly:

| Capability | Pong | MIMEcroft |
|---|---|---|
| Many draw calls per frame | 6 | hundreds (instanced cubes) |
| 3D world model / collision | none (2D) | voxel grid, raycasting |
| Game state data structures | 4 scalars | arrays: map, entities, treasures |
| AI | 1 paddle | N MIME mobs with distinct behaviours |
| Win/lose condition | score 10 | treasure hunt, health |
| Sound | none | `/dev/audio` notes |
| HUD | on-canvas squares | **the terminal itself** |
| Proves | "bash can do a game loop" | "bash can do a *world*" |

There is a historical footnote: a partial `mimecroft.sh` once existed
(`__mime-test.mjs` still references `/tmp/mimecroft.sh`). It is gone, but
the runtime support it was written against survives and is the foundation
for this proposal — the `/dev/webgl` device with its key queue and headless
null device, the float-aware `sleep` builtin, and the transpile-and-run
test harness. This proposal specifies the game **from scratch** against
those existing pieces.

---

## The World

### Voxel grid

The maze is a **16 × 16 × 4** grid of cells (`MAP_W × MAP_D × MAP_H`),
stored in one flat bash array indexed by
`i = y * (MAP_D * MAP_W) + z * MAP_W + x`. All coordinates are **integers**
— cells, not meters. This single decision removes every floating-point
headache from the game (see [Math Strategy](#math-strategy-integers-by-default-bc-by-choice)).

### Block palette

| ID | Block | Colour (r g b) | Hardness | Notes |
|---|---|---|---|---|
| 0 | air | — | — | walkable, transparent |
| 1 | dirt | `0.55 0.35 0.20` | 1 shot | maze floor walls, easy mining |
| 2 | stone | `0.55 0.55 0.58` | 2 shots | denser regions |
| 3 | obsidian | `0.10 0.10 0.13` | 3 shots | blocks *cannot be shot through* — must go around or dig |
| 4 | gold | `0.95 0.75 0.10` | 1 shot | rare, glows in the palette |
| 5 | diamond | `0.20 0.85 0.85` | 2 shots | very rare |
| 6 | ruby | `0.85 0.15 0.20` | 2 shots | very rare |
| 7 | treasure | `0.15 0.80 0.35` | 1 shot | **contains an OS artifact** (below) |

Hardness = number of shots to destroy. Every block is destructible —
"shooting blocks destroys them" is the mining mechanic. Obsidian blocks the
ray until it is destroyed, so the maze has both corridors *and* walls you
must dig through.

### Treasures (the win condition)

Hidden treasure blocks contain one artifact each. Mining a treasure block
reveals its name, grants a power-up, and *attracts* MIMEs to your position
(the swarm wants to re-corrupt the artifact). Collect all to win.

| Artifact | Colour flash | Power-up |
|---|---|---|
| GNU Hurd | emerald | +1 max HP |
| Linux | white | +movement speed for 20 s |
| FreeBSD | red | rapid fire for 20 s |
| NetBSD | orange | +1 armour (absorb next hit) |
| OpenBSD | turquoise | shooting pierces 1 extra block |
| Plan 9 | blue | everything-is-a-file: +1 treasure slot |
| Minix | yellow | +1 HP |
| Solaris | purple | +1 max HP |
| macOS (Darwin) | pink | rapid fire for 10 s |
| Unix | grey | +2 HP (it's old, it's tough) |

### The evil MIMEs

MIMEs occupy one cell each, move on the same grid, and chase the player
with a greedy Manhattan-descent AI (always reduce the distance, prefer
moving along corridors, jitter with `$RANDOM` when stuck). Contact damages
the player. They are colour-coded by their content type.

| MIME | Colour | HP | Behaviour |
|---|---|---|---|
| `image/jpeg` | orange | 1 | slow, bulky, deals 2 damage — the tank |
| `image/png` | green | 1 | fast, zig-zags — the sneaky one |
| `application/octet-stream` | grey | 1 | spawns in swarms of 4 — the blob |
| `text/plain` | white | 1 | patrols corridors, ignores you until shot — then aggroes the whole swarm |
| `audio/mpeg` | yellow | 2 | erratic movement (random turns), deafening hum on `/dev/audio` |
| `video/mp4` | magenta | 2 | every 4th turn, spawns an `image/png` — the spawner |
| **`application/x-shellscript`** | red | 5 | **the boss**: the MIME that ate the shell. Slow, but shoots back and spews `text/plain` minions. Appears after 6 treasures found |

---

## Controls

The `/dev/webgl` device gives us a keyboard queue, not a mouse. Rather than
fight that, the design embraces it — MIMEcroft is a **grid-based dungeon
crawler** (think *The Bard's Tale* or *Eye of the Beholder*), which is the
perfect genre for bash:

| Key | Action |
|---|---|
| `W` / `S` | step forward / back (one cell) |
| `A` / `D` | strafe left / right (one cell) |
| `←` / `→` | turn 90° left / right |
| `space` | shoot a ray straight ahead |
| `Q` | quit |

Movement and turning are **discrete** — one cell per press, 90° per turn.
Collision is then trivial (is the target cell air?), the camera never needs
smooth interpolation, and the render order falls out of the facing
direction with no sorting (see [Rendering](#rendering)). No floats, no
trig, no matrix math in bash. The GPU does the only trigonometry, and only
on exact multiples of 90°.

---

## The Device Contract

Everything the game touches already exists in `src/fs/webgldev.js` and
`src/fs/audiodev.js`. The game script writes these files; the device does
the GL work. This is the whole "filesystem-as-API" bet paying off.

### `/dev/webgl/*` (from `webgldev.js`)

| Path | Direction | Payload |
|---|---|---|
| `shader/vertex`, `shader/fragment` | write | GLSL ES 1.00 source (WebGL1) |
| `program` | write | `link` |
| `buffer/<name>` | write | typed data: `f32 …`, `u16 …` (indices) |
| `bind` | write | `<attribute> <buffer> [size]` (else auto-binds by name) |
| `uniform/<1f\|2f\|3f\|4f\|1i\|m4>/<name>` | write | values, e.g. `3 5 1` |
| `clearcolor` | write | `r g b a` |
| `call` | write | `clear` \| `swap` \| `hide` \| `draw [arrays\|elements] <mode> <count> <offset>` |
| `key` | **read** | comma-separated key queue (`space` = spacebar), drained on read |
| `frame` | read | PNG data URL of current frame |
| `log`, `state`, `info`, `program`, `bind` | read | introspection (used by the test harness) |

Notes that matter for the game:

- **`swap`** shows the canvas and **steals the keyboard** into the key
  queue; **`hide`** returns the keyboard to the shell. A game loop is:
  `read keys → update → render → swap → sleep`; quit with `hide`.
- Buffers auto-bind to attributes by name, so naming the buffers
  `aPosition`, `aShade` is enough — no `bind` writes needed.
- The device has a **NullGL headless mode**: with no DOM it accepts every
  write and logs every call, so the game runs logic-only under `node`
  (this is how the test harness works).

### `/dev/audio/*` (from `audiodev.js`)

`echo "note A4 0.1" > /dev/audio/note`, plus `on|off|freq|wave|gain`.
One-liner sound effects: shot = `note 880 0.05`, block hit = `note 220 0.08`,
treasure found = three ascending notes, MIME death = descending slide.

### The terminal is the HUD

The canvas is the 3D view; **the shell terminal is the dashboard**:

```
MIMEcroft — treasures 3/10   HP ██████░░  score 42
  [ASCII minimap, 16×16, player @, treasure ?, MIME !]
  > You mined a block and found: FreeBSD  (+rapid fire 20s)
```

Score, health, inventory, the event log, and an **ASCII minimap** — all
plain `echo` to stdout, all of it bash. This is the most *shell-native*
part of the game, and it makes the terminal scrollback itself the
"trailer" (the repo already records `.cast` files — see Milestones).

## The fragment shader is written in bash

MIMEcroft took the vision one step further: **the fragment shader itself
is authored in bash** (`examples/mimecroft-frag.sh`) and compiled to GLSL
by the sh→GLSL backend (`glsl_backend.rs` in the sh2perl repo, exposed
as the `sh2glsl` command). The game writes the bash program to `/tmp` at
startup and compiles it:

```bash
emit_fragment_shader() {
  echo 'fx=$((frag_x))' > /tmp/mimecroft-frag.sh
  …
  echo 'putb 255' >> /tmp/mimecroft-frag.sh
  glsl=$(sh2glsl /tmp/mimecroft-frag.sh)
  if [ "$glsl" != "" ]; then
    echo "$glsl" > /dev/webgl/shader/fragment
  else
    echo "precision mediump float; varying vec4 vColor; …" > /dev/webgl/shader/fragment
  fi
}
```

The generator extension (GLSL ES 1.00 + render mode) bridges the game's
vertex shader into bash terms:

| bash variable | GLSL bridge |
|---|---|
| `frag_x`, `frag_y` | `int(gl_FragCoord.xy)` — the pixel position |
| `vcolor_r/g/b` | `int(vColor.rgb * 255.0)` — the block colour varying |
| `putb N` | `putCh(N)` — one byte of the fragment's RGBA output |
| `out_buf[0..3]` | `gl_FragColor = vec4(…)/255.0` |

The compiled shader computes the game's CRT-scanline, corruption
flicker and vignette effects with pure integer arithmetic — no floats,
no GLSL, just bash that happens to run on the GPU. `examples/mimecroft-frag.glsl`
is the generated artifact; regenerate it with `sh2glsl examples/mimecroft-frag.sh`.

---

## Rendering

### One cube, many draws

There is a single unit cube in one index buffer (24 vertices, 36 u16
indices). Each block is drawn with two uniforms:

```
echo "draw elements triangles 36 0 cube" > /dev/webgl/call
```

with `uObjPos` = the block's cell and `uBlockColor` = its palette colour.
Per-face shading is **baked into the cube's vertex data at startup**: the
`aShade` attribute is `1.0` on the top face, `0.7` on the sides, `0.45` on
the bottom. The shader multiplies shade × block colour, so every block
instantly looks 3D with zero lighting code.

### The shader (GLSL ES 1.00 — WebGL1)

```glsl
// /dev/webgl/shader/vertex
attribute vec3 aPosition;   // unit cube, centred at origin
attribute vec3 aShade;      // baked per-face brightness
uniform vec3  uCamPos;      // player cell (integers)
uniform float uCamYaw;      // degrees: 0, 90, 180, 270
uniform vec3  uObjPos;      // this block's cell
uniform vec3  uBlockColor;
varying vec3  vColor;
void main() {
  // eye sits in the middle of the player's cell
  vec3 cam = uCamPos + vec3(0.5, 0.5, 0.5);
  vec3 d = aPosition + uObjPos - cam;
  // world → camera space: rotate around Y, look down -Z.
  // yaw is a multiple of 90°, so cos/sin are exactly 0/±1 here.
  float a = uCamYaw * 0.0174532925;
  float c = cos(a), s = sin(a);
  vec3 rel = vec3(d.x * c + d.z * s, d.y, -d.x * s + d.z * c);
  // naive perspective: divide by depth (clamped, in front only)
  float z = max(-rel.z, 0.05);
  gl_Position = vec4(rel.x * 0.9 / z, rel.y * 0.9 / z, rel.z / 64.0, 1.0);
  vColor = aShade * uBlockColor;
}
```

```glsl
// /dev/webgl/shader/fragment
precision mediump float;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }
```

Because the world is rotated around the camera (not the cube) and the cube
is axis-aligned, the cube geometry never moves in the shader — only the
camera matrix is applied. Since yaw is exactly 0/90/180/270, the rotation
is a sign-swap and axis-swap, which the GPU handles from the constant
`cos`/`sin` values. **Bash never computes a matrix or a trig function** —
unless you opt into the `bc`-powered smooth-turn mode (see
[Math Strategy](#math-strategy-integers-by-default-bc-by-choice)), in
which case the shader accepts any fractional `uCamYaw` unchanged.

### Painter's algorithm without sorting

Blocks are opaque and axis-aligned, and the camera always looks straight
down a grid axis. So "far to near" is simply **descending coordinate along
the facing axis** — no `sort`, no distances, no depth buffer:

```bash
# yaw 0 → facing -z: iterate z from far (high) to near (low)
# yaw 1 → facing +x: iterate x from far (high) to near (low)
# ...and so on
render_pass() {
  local dir=${FACING[$yaw]}   # 'x+' 'x-' 'z+' 'z-'
  local y x z
  for ((y = MAP_H - 1; y >= 0; y--)); do          # top-down is fine
    case $dir in
      z-) for ((z = MAP_D - 1; z >= 0; z--)); do for ((x = 0; x < MAP_W; x++)); do
            try_draw_cell $x $y $z; done; done ;;
      z+) for ((z = 0; z < MAP_D; z++));     do for ((x = 0; x < MAP_W; x++)); do
            try_draw_cell $x $y $z; done; done ;;
      x-) for ((x = MAP_W - 1; x >= 0; x--)); do for ((z = 0; z < MAP_D; z++)); do
            try_draw_cell $x $y $z; done; done ;;
      x+) for ((x = 0; x < MAP_W; x++));     do for ((z = 0; z < MAP_D; z++)); do
            try_draw_cell $x $y $z; done; done ;;
    esac
  done
}
```

`try_draw_cell` skips air, skips cells farther than `VIEW_R` cells from the
camera, draws blocks and MIME entities (same cube, different
`uBlockColor`). Worst case ≈ a few hundred tiny draw calls per frame —
nothing for WebGL, and in the transpiled JS each call is a function call,
not a subprocess.

### Culling that falls out of the grid

Frustum culling is a bounding check on the *same* axis loop: with yaw
facing `+x`, visible cells satisfy roughly
`|z - pz| ≤ 2·|x - px|` (45° half-FOV). In bash that's one integer
comparison per cell, in the loop that's already running. Cheap, correct
enough, and keeps the draw count small.

---

## Game Logic (bash sketch)

### State

```bash
# flat map: i = y*(MAP_D*MAP_W) + z*MAP_W + x
declare -a map
# player
px=2; py=1; pz=2; yaw=0          # yaw: 0=-z 1=+x 2=+z 3=-x
hp=10; maxhp=10; score=0
declare -a found                 # treasures found (names)
# mimes
declare -a mx mz my mtype mhp    # parallel arrays
mime_count=0
# facing vectors (indexed by yaw)
DIR_X=(0 1 0 -1); DIR_Z=(-1 0 1 0)
```

### Maze generation — drunkard's walk

A recursive backtracker in bash is doable but fiddly; a drunkard's walk is
five lines and produces properly maze-ish geometry with guaranteed open
paths and natural rooms:

```bash
gen_maze() {
  # fill everything with stone
  local i; for ((i = 0; i < MAP_W * MAP_D * MAP_H; i++)); do map[$i]=$STONE; done
  # carve ~55% of the floor cells with a random walk
  local x=$((MAP_W / 2)) z=$((MAP_D / 2)) y=1 steps=0
  while [ $steps -lt $((MAP_W * MAP_D * 55 / 100)) ]; do
    set_cell $x $y $z $AIR
    case $((RANDOM % 4)) in
      0) x=$((x + 1));; 1) x=$((x - 1));;
      2) z=$((z + 1));; 3) z=$((z - 1));;
    esac
    # bounce off walls
    [ $x -lt 1 ] && x=1; [ $x -ge $((MAP_W - 1)) ] && x=$((MAP_W - 2))
    [ $z -lt 1 ] && z=1; [ $z -ge $((MAP_D - 1)) ] && z=$((MAP_D - 2))
    steps=$((steps + 1))
  done
  # sprinkle coloured blocks and treasure on the carved floor
  scatter_blocks
}
```

`$RANDOM` also makes the maze seedable (a fixed `RANDOM` assignment before
`gen_maze` reproduces a maze — essential for the test harness).

### Movement & turning

```bash
move() {  # $1 = +1 forward / -1 back / strafe via $2
  local dx=$((DIR_X[yaw] * $1 + DIR_Z[yaw] * $2))
  local dz=$((DIR_Z[yaw] * $1 - DIR_X[yaw] * $2))
  local nx=$((px + dx)) nz=$((pz + dz))
  if [ "${map[$((py * MAP_D * MAP_W + nz * MAP_W + nx))]}" = "$AIR" ] \
     && ! mime_at $nx $nz $py; then
    px=$nx; pz=$nz
  fi
}
```

### Shooting — a straight ray down the corridor

Because the eye is at fixed height and the player shoots horizontally, the
ray is a **1-D walk along the facing row** — integer DDA with no
arithmetic at all:

```bash
shoot() {
  local i tx tz id
  for ((i = 1; i <= RANGE; i++)); do
    tx=$((px + DIR_X[yaw] * i)); tz=$((pz + DIR_Z[yaw] * i))
    id=${map[$((py * MAP_D * MAP_W + tz * MAP_W + tx))]}
    if [ "$id" != "$AIR" ]; then
      damage_block $tx $tz $py $id; return 0     # hit a block
    fi
    if mime_at $tx $tz $py; then
      kill_mime_at $tx $tz; return 0              # hit a MIME
    fi
  done
  return 1                                        # missed
}
```

`damage_block` decrements the block's hardness (re-seeded from the palette
table) and converts it to air when spent; treasure blocks hand out an
artifact when destroyed. `kill_mime_at` removes the entity, adds score, and
plays a note.

### MIME AI — greedy descent

```bash
update_mimes() {
  local i
  for ((i = 0; i < mime_count; i++)); do
    # move toward player on the cheaper axis; jitter when blocked
    local dx=$((px - mx[i])) dz=$((pz - mz[i]))
    local nx=${mx[i]} nz=${mz[i]}
    if [ $((RANDOM % 3)) = 0 ] && [ $dx != 0 ] && [ $dz != 0 ]; then
      # erratic behaviour: pick the more distant axis sometimes
      [ ${dx#-} -ge ${dz#-} ] && nx=$((mx[i] + (dx > 0 ? 1 : -1))) || nz=$((mz[i] + (dz > 0 ? 1 : -1)))
    elif [ ${dx#-} -ge ${dz#-} ]; then
      nx=$((mx[i] + (dx > 0 ? 1 : -1)))
    else
      nz=$((mz[i] + (dz > 0 ? 1 : -1)))
    fi
    # step only into air; otherwise stay put (or damage the player)
    if [ "${map[$((my[i] * MAP_D * MAP_W + nz * MAP_W + nx))]}" = "$AIR" ] \
       && ! mime_at $nx $nz ${my[i]}; then
      mx[i]=$nx; mz[i]=$nz
    fi
    # contact damage
    if [ ${mx[i]} = $px ] && [ ${mz[i]} = $pz ]; then hurt $((MIME_DMG[mtype[i]])); fi
  done
}
```

### The main loop

```bash
while [ $hp -gt 0 ] && [ ${#found[@]} -lt ${#TREASURES[@]} ]; do
  read_keys                      # cat /dev/webgl/key, dispatch one action
  update_mimes
  update_effects                 # rapid fire / speed timers
  render_frame                   # clear → axis-ordered draw pass → swap
  hud                           # echo score / health / minimap to terminal
  sleep 0.1                     # ~10 fps of discrete turns
done
echo "hide" > /dev/webgl/call   # give the keyboard back to the shell
end_screen                      # banner, score, hide/win flash
```

`sleep 0.1` is already supported by the runtime builtin (`builtins.js`:
"sleep [N] — delay for N seconds (floats ok) … Needed by game loops
(mimecroft)"), which is the runtime literally anticipating this game.

---

## Math Strategy: Integers by Default, bc by Choice

The vision document's Pong leaned on `bc` for every bounce. That works
(and per the vision doc, sh2perl collapses each `bc` pipeline into inline
JS arithmetic, so in the browser it costs nothing) but it makes pure-bash
debug runs noisy and slow. MIMEcroft therefore keeps the **world model
integer-only** — everything that runs every tick stays cheap — and uses
`bc` deliberately for the **polish that genuinely needs floats**:

| Problem | Integer default | bc upgrade path |
|---|---|---|
| Position | integer cell coordinates | lerp between cells for smooth stepping |
| Rotation | 4 discrete yaws (0/90/180/270) | continuous yaw for smooth turns |
| Collision | `[ "$cell" = "$AIR" ]` | sub-cell entity positions (radius checks) |
| Raycast | 1-D integer walk along a grid row | proper DDA at arbitrary angles |
| Render order | axis-ordered iteration (no sort) | distance-sorted draw list |
| View matrix | camera-space math in the shader | `bc`-computed `m4` uniform (`/dev/webgl/uniform/m4`) |

The defaults keep the core loop at interactive speed even in stock bash;
the `bc` upgrades are opt-in and mostly matter for the transpiled browser
build, where they are free anyway. The one non-negotiable is that **bc
never appears in the per-frame hot path of a pure-bash run** — that was
Pong's pain point and it is avoidable.

Concrete example — a smooth-turn upgrade (hold `←`/`→` to rotate
continuously instead of snapping 90°):

```bash
# target_yaw accumulates in degrees, yaw eases toward it with bc
while [ "$(echo "$yaw < $target_yaw" | bc)" = 1 ]; do
    yaw=$(echo "$yaw + $TURN_SPEED" | bc)
    if [ "$(echo "$yaw > $target_yaw" | bc)" = 1 ]; then yaw=$target_yaw; fi
    echo "$yaw" > /dev/webgl/uniform/1f/uCamYaw   # shader already accepts any angle
    render_frame
    sleep 0.016
done
```

The shader above already handles arbitrary `uCamYaw` — `cos`/`sin` are
computed on the GPU, so nothing else changes. The same pattern upgrades
treasure sparkle effects, camera bob, and MIME wobble. The only decimals
that must *never* be computed are the world-state ones; the rest is fair
game for `bc`.

---

## What sh2perl Transpiles

Per the vision document, every construct below is already parsed and
lowered; the generated JS calls `sh2runtime`'s fs, not the browser:

| Shell | Generated JS |
|---|---|
| `declare -a map; map[$i]=$STONE` | `let map = []; map[i] = STONE;` |
| `${map[$((i))]}` | `map[i]` |
| `echo "f32 …" > /dev/webgl/buffer/aPosition` | `fs.write("/dev/webgl/buffer/aPosition", …)` |
| `cat /dev/webgl/key` | `await fs.read("/dev/webgl/key")` |
| `echo "draw elements triangles 36 0 cube" > /dev/webgl/call` | `fs.write("/dev/webgl/call", …)` |
| `echo "note A4 0.1" > /dev/audio/note` | `fs.write("/dev/audio/note", …)` |
| `[ "${map[i]}" = "$AIR" ]` | `if (map[i] === AIR)` |
| `for ((x = 0; x < MAP_W; x++))` | `for (let x = 0; x < MAP_W; x++)` |
| `x=$((x + 1))`, `$RANDOM` | `x = x + 1`, `Math.random()` |
| `sleep 0.1` | `await new Promise(r => setTimeout(r, 100))` |
| `local` | `let` (scoped) |

In the browser the compiled bash *is* the game loop, running at native JS
speed. The draw calls become `fs.write` promises to the WebGL device —
each frame is ~300 fast async writes, comfortably within budget at 10-30
fps for discrete-turn gameplay.

---

## Test Harness (already exists)

`__mime-test.mjs` was built for the previous incarnation and is ready to be
pointed at the new script. It:

1. reads `/tmp/mimecroft.sh`,
2. transpiles it with `bashToJS`,
3. runs the result in `createSh2Runtime` with a stub `shellExec`
   (echo/cat/sleep/true) and the **real NullGL-backed `/dev/webgl`**,
4. feeds scripted keys through `/dev/webgl/key` ("w,ArrowLeft,space,…"),
5. asserts on `/dev/webgl/log` (draw calls, shader compile), uniform
   state (`uCamPos`, `uObjPos`), and stdout (score lines, HUD).

Because the map is `$RANDOM`-seeded and keys are scripted, a playthrough is
**deterministic**: the harness can assert "after 200 sleeps the camera
moved, a draw happened, a block was destroyed" and, in a longer run, "the
treasure was found and the win screen printed". No browser needed; the
browser build (`index.html` + real WebGL) is the same script with a real
DOM.

---

## Milestones

| # | Deliverable | Acceptance test |
|---|---|---|
| M0 | Skeleton: shaders, cube buffers, one static maze frame | harness: log shows `[shader/vertex] compiled OK`, ≥1 `[call] draw` per swap |
| M1 | Movement + turning + collision | scripted `w,w,left,w` moves `uCamPos` 2 cells, no wall clip |
| M2 | Shooting + block destruction | scripted `space` after `left` turns: a cell becomes air in `map` |
| M3 | MIME spawn + chase + damage + death | scripted stand-still: `hp` drops, `score` rises after a kill |
| M4 | Treasures, win/lose, HUD, audio notes | full playthrough script: 10/10 treasures, win banner, `hide` called |
| M5 | Boss `application/x-shellscript`, power-ups, minimap polish | seeded hard seed: boss spawns after 6 treasures |
| M5.5 | bc polish: continuous-turn mode (`bc`-eased `uCamYaw`), camera bob, treasure sparkle | scripted held-arrow key: `uCamYaw` writes show fractional degrees |
| M6 | Browser demo + asciinema trailer | `index.html` runs it; `our_mimecroft.cast` records the terminal HUD |

M0–M4 are pure script work against existing runtime code. M6 is the payoff
that matches the repo's existing `.cast`-based demo style: an asciinema of
the **terminal HUD** (minimap scrolling, "You found: FreeBSD", the score
line) is the trailer, while the WebGL canvas is the gameplay.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Bash too slow for hundreds of draws/frame | Integer-only hot path, axis-ordered culling, `VIEW_R` radius; `bc` used only for opt-in polish; transpiled JS is native speed anyway |
| GLSL ES 1.00 surprises | Single trivial shader pair, compiled and logged by the device; NullGL surfaces syntax errors in CI |
| Keyboard-only input feels limited | Genre is grid-based crawler by design; 90° turns are the genre's native idiom |
| `$RANDOM` nondeterminism in tests | Seed before `gen_maze`; scripted key stream makes runs reproducible |
| Draw-call ordering bugs (painter's) | Axis order is provably far-to-near for a camera on the lattice; covered by frame snapshot tests |

---

## Summary

MIMEcroft.sh is the second act of the bash-game vision. Pong proved the
game loop; MIMEcroft proves the **world** — a voxel maze, entity AI,
raycasting, a treasure hunt, and a win condition, all in pure POSIX shell
over the `/dev/webgl` and `/dev/audio` filesystems. The runtime pieces it
needs (device, key queue, NullGL, float `sleep`, the harness) are already
shipped in `sh2runtime`; only the script itself remains to be written —
and this proposal is its spec.

The joke remains the language. The serious part remains the architecture:
shell → AST → JS → browser APIs, with the filesystem as the API and the
terminal as the dashboard. A game where **you are a shell command digging
through a corrupted filesystem to rescue operating systems from hostile
MIME types** could only be written in bash — and now we know exactly how.

---

*See also: [bash-game-vision.md](bash-game-vision.md) for the architectural
vision and Pong reference implementation, and
[architectural-considerations.md](architectural-considerations.md) for the
transpiler foundation.*
