# A 3D Game Written in Bash

## (Speculative Vision)

This document explores the endgame of the Plan 9-style filesystem-as-API
metaphor running on top of sh2perl's transpiler architecture. It is
**aspirational** — none of this works today. It illustrates the direction.

---

## The Concept

Every browser capability is a file. The shell provides the glue. The
transpiler generates JavaScript that talks to browser APIs through a
virtual filesystem layer.

```
/dev
├── webgl/           # WebGL 2.0 via filesystem writes
│   ├── info         # (read) GPU vendor, renderer, version
│   ├── shader/vertex   # (write) vertex shader source
│   ├── shader/fragment # (write) fragment shader source
│   ├── buffer/     # (write) buffer data
│   ├── texture/    # (write) texture data
│   ├── uniform/1f  # (write) float uniform
│   ├── uniform/2f  # (write) vec2 uniform
│   ├── uniform/3f  # (write) vec3 uniform
│   ├── uniform/4f  # (write) vec4 uniform
│   ├── uniform/1i  # (write) int uniform
│   ├── uniform/m4  # (write) mat4 uniform (16 floats)
│   ├── call        # (write) draw command
│   └── frame       # (read) grab current frame as PNG
├── audio/          # WebAudio
│   ├── osc         # (write) oscillator frequency + gain
│   ├── sample      # (write) play a WAV sample
│   └── spectrum    # (read) FFT data
├── input/          # Gamepad / keyboard
│   ├── keyboard    # (read) current key states
│   ├── mouse       # (read) mouse position + buttons
│   └── gamepad/0   # (read) gamepad axis + button states
├── camera/         # WebCamera
│   └── frame       # (read) snapshot as PNG
└── pc/             # Download/Upload
    └── ...         # (write) trigger download, (read) file picker
```

---

## Pong in Bash

Here is a complete, playable 3D Pong game. The player controls the left
paddle via the keyboard (`W`/`S`). The right paddle is AI-controlled.

```bash
#!/usr/bin/env sh2perl
# pong.sh — Fully playable 3D Pong in the browser
# Usage: bash pong.sh  (after mounting /dev/webgl)

# ─── Configuration ──────────────────────────────────────────────
WINDOW_W=800
WINDOW_H=600
PADDLE_SPEED=0.02
BALL_SPEED=0.025
PADDLE_WIDTH=0.02
PADDLE_HEIGHT=0.15
BALL_SIZE=0.03

# Initial positions
ball_x=0.0
ball_y=0.0
ball_vx="$BALL_SPEED"
ball_vy="$BALL_SPEED"
paddle1_y=0.0
paddle2_y=0.0
score1=0
score2=0

# ─── Set up WebGL ────────────────────────────────────────────────

setup_webgl() {
    # Query GPU info
    echo "=== GPU Info ==="
    cat /dev/webgl/info
    echo ""

    # Vertex shader — transforms positions, passes color
    cat > /tmp/vert.glsl << 'EOF'
attribute vec2 aPosition;
uniform vec2 uOffset;
uniform vec2 uScale;
void main() {
    vec2 pos = aPosition * uScale + uOffset;
    gl_Position = vec4(pos, 0.0, 1.0);
}
EOF

    # Fragment shader — solid color
    cat > /tmp/frag.glsl << 'EOF'
uniform vec3 uColor;
void main() {
    gl_FragColor = vec4(uColor, 1.0);
}
EOF

    # Upload shaders
    cat /tmp/vert.glsl > /dev/webgl/shader/vertex
    cat /tmp/frag.glsl > /dev/webgl/shader/fragment

    # Upload a unit quad (2 triangles forming a rectangle)
    # Used for paddles, ball, court markings
    echo "f32 -1 -1  1 -1  1 1  -1 1" > /dev/webgl/buffer/quad
    echo "u16 0 1 2  0 2 3" > /dev/webgl/buffer/quad_indices

    # Set clear color (dark court green)
    echo "0.05 0.15 0.05 1.0" > /dev/webgl/clearcolor
}

# ─── Drawing Primitives ──────────────────────────────────────────

# Draw a rectangle at (x, y) with given size and color
draw_rect() {
    local x=$1
    local y=$2
    local w=$3
    local h=$4
    local r=$5
    local g=$6
    local b=$7

    # Set uniforms: position offset, scale (half-width, half-height)
    echo "$x $y" > /dev/webgl/uniform/2f/offset
    echo "$w $h" > /dev/webgl/uniform/2f/scale
    echo "$r $g $b" > /dev/webgl/uniform/3f/color

    # Draw the quad
    echo "draw elements triangles 6 0" > /dev/webgl/call
}

# Draw the ball as a small square (we could use a circle shader, but
# this keeps it simple)
draw_ball() {
    draw_rect "$ball_x" "$ball_y" "$BALL_SIZE" "$BALL_SIZE" \
              1.0 1.0 1.0
}

# Draw the center line (dashed)
draw_center_line() {
    local y
    y=-0.9
    while [ "$(echo "$y < 0.9" | bc)" = "1" ]; do
        draw_rect 0.0 "$y" 0.005 0.05 0.3 0.3 0.3
        y=$(echo "$y + 0.12" | bc)
    done
}

# Draw the scoreboard as points on the court
draw_score() {
    # Simple: draw small squares representing scores
    local i
    i=0
    while [ "$i" -lt "$score1" ]; do
        draw_rect -0.15 $(echo "0.85 - $i * 0.06" | bc) \
                  0.01 0.04 1.0 1.0 1.0
        i=$((i + 1))
    done
    i=0
    while [ "$i" -lt "$score2" ]; do
        draw_rect 0.15 $(echo "0.85 - $i * 0.06" | bc) \
                  0.01 0.04 1.0 1.0 1.0
        i=$((i + 1))
    done
}

# ─── Game Logic ──────────────────────────────────────────────────

update_ball() {
    # Move ball
    ball_x=$(echo "$ball_x + $ball_vx" | bc)
    ball_y=$(echo "$ball_y + $ball_vy" | bc)

    # Top / bottom wall bounce
    if [ "$(echo "$ball_y + $BALL_SIZE > 1.0" | bc)" = "1" ]; then
        ball_vy=$(echo "-$ball_vy" | bc)
        ball_y=1.0
    fi
    if [ "$(echo "$ball_y - $BALL_SIZE < -1.0" | bc)" = "1" ]; then
        ball_vy=$(echo "-$ball_vy" | bc)
        ball_y=-1.0
    fi

    # Paddle 1 collision (left)
    if [ "$(echo "$ball_x - $BALL_SIZE < -0.95 + $PADDLE_WIDTH" | bc)" = "1" ]; then
        local diff
        diff=$(echo "$ball_y - $paddle1_y" | bc)
        if [ "$(echo "$diff < $PADDLE_HEIGHT && $diff > -$PADDLE_HEIGHT" | bc)" = "1" ]; then
            ball_vx=$(echo "$BALL_SPEED" | bc)
            # Add spin based on where the ball hit the paddle
            ball_vy=$(echo "$ball_vy + $(echo "$diff * 0.3" | bc)" | bc)
        else
            # Miss — player 2 scores
            score2=$((score2 + 1))
            reset_ball
        fi
    fi

    # Paddle 2 collision (right)
    if [ "$(echo "$ball_x + $BALL_SIZE > 0.95 - $PADDLE_WIDTH" | bc)" = "1" ]; then
        local diff
        diff=$(echo "$ball_y - $paddle2_y" | bc)
        if [ "$(echo "$diff < $PADDLE_HEIGHT && $diff > -$PADDLE_HEIGHT" | bc)" = "1" ]; then
            ball_vx=$(echo "-$BALL_SPEED" | bc)
            ball_vy=$(echo "$ball_vy + $(echo "$diff * 0.3" | bc)" | bc)
        else
            # Miss — player 1 scores
            score1=$((score1 + 1))
            reset_ball
        fi
    fi

    # Clamp ball velocity so it doesn't go too fast
    if [ "$(echo "$ball_vy > $BALL_SPEED * 2" | bc)" = "1" ]; then
        ball_vy=$(echo "$BALL_SPEED * 2" | bc)
    fi
    if [ "$(echo "$ball_vy < -$BALL_SPEED * 2" | bc)" = "1" ]; then
        ball_vy=$(echo "-$BALL_SPEED * 2" | bc)
    fi
}

reset_ball() {
    ball_x=0.0
    ball_y=0.0
    # Serve toward the player who was scored on
    if [ "$((RANDOM % 2))" = "0" ]; then
        ball_vx="$BALL_SPEED"
    else
        ball_vx=$(echo "-$BALL_SPEED" | bc)
    fi
    ball_vy=$(echo "(($RANDOM % 100) - 50) * $BALL_SPEED / 50" | bc)
    sleep 0.5
}

update_ai() {
    # Simple AI: track the ball with some laziness
    local diff
    diff=$(echo "$ball_y - $paddle2_y" | bc)
    if [ "$(echo "$diff > 0.02" | bc)" = "1" ]; then
        paddle2_y=$(echo "$paddle2_y + $PADDLE_SPEED * 0.7" | bc)
    elif [ "$(echo "$diff < -0.02" | bc)" = "1" ]; then
        paddle2_y=$(echo "$paddle2_y - $PADDLE_SPEED * 0.7" | bc)
    fi
}

handle_input() {
    # Read keyboard state
    local keys
    keys=$(cat /dev/input/keyboard)

    # Check if the keys string contains 'w' or 'W'
    if echo "$keys" | grep -q '^.*[Ww].*$'; then
        paddle1_y=$(echo "$paddle1_y + $PADDLE_SPEED" | bc)
    fi

    # Check for 's' or 'S'
    if echo "$keys" | grep -q '^.*[Ss].*$'; then
        paddle1_y=$(echo "$paddle1_y - $PADDLE_SPEED" | bc)
    fi

    # Clamp paddles to court bounds
    local max_y
    max_y=$(echo "1.0 - $PADDLE_HEIGHT" | bc)
    if [ "$(echo "$paddle1_y > $max_y" | bc)" = "1" ]; then
        paddle1_y="$max_y"
    fi
    if [ "$(echo "$paddle1_y < -$max_y" | bc)" = "1" ]; then
        paddle1_y=$(echo "-$max_y" | bc)
    fi
    if [ "$(echo "$paddle2_y > $max_y" | bc)" = "1" ]; then
        paddle2_y="$max_y"
    fi
    if [ "$(echo "$paddle2_y < -$max_y" | bc)" = "1" ]; then
        paddle2_y=$(echo "-$max_y" | bc)
    fi
}

# ─── Frame Render ────────────────────────────────────────────────

render_frame() {
    # Clear buffer
    echo "clear" > /dev/webgl/call

    # Draw court
    draw_center_line

    # Draw paddles
    draw_rect -0.95 "$paddle1_y" "$PADDLE_WIDTH" "$PADDLE_HEIGHT" \
              1.0 1.0 1.0
    draw_rect 0.95 "$paddle2_y" "$PADDLE_WIDTH" "$PADDLE_HEIGHT" \
              1.0 1.0 1.0

    # Draw ball
    draw_ball

    # Draw score
    draw_score

    # Swap buffers (present to screen)
    echo "swap" > /dev/webgl/call
}

# ─── Main Game Loop ──────────────────────────────────────────────

echo "=== PONG ==="
echo "Player 1: W/S keys"
echo "Player 2: CPU"
echo "First to 10 wins!"
echo ""
echo "Starting in 3..."
sleep 1
echo "2..."
sleep 1
echo "1..."
sleep 1
echo "GO!"

setup_webgl

# Game loop: 60 FPS ≈ 16ms per frame
while [ "$score1" -lt 10 ] && [ "$score2" -lt 10 ]; do
    handle_input
    update_ai
    update_ball
    render_frame
    sleep 0.016
done

# Game over
if [ "$score1" -ge 10 ]; then
    echo "Player 1 wins!"
else
    echo "CPU wins!"
fi

# Flash the screen for dramatic effect
echo "1 0 0 1" > /dev/webgl/clearcolor
echo "clear" > /dev/webgl/call
echo "swap" > /dev/webgl/call
sleep 2
```

## How sh2perl Transpiles This

The shell parser sees:

- **Variable assignments** → `let score1 = 0;`
- **`cat > file << 'EOF'`** ✗ string literal assignment
- **`echo > /dev/webgl/...`** → `runtime.fs.write("/dev/webgl/...", value)`
- **`cat /dev/input/keyboard`** → `runtime.fs.read("/dev/input/keyboard")`
- **`[ "$(echo ...)" = "1" ]`** → `if (...)`
- **`while [ "$score1" -lt 10 ]`** → `while (score1 < 10)`
- **`sleep 0.016`** → `await new Promise(r => setTimeout(r, 16))`
- **`$((i + 1))`** → `i + 1`
- **`local` variables** → `let` (scoped)

The generated JavaScript (simplified):

```javascript
// Generated by sh2perl from pong.sh
import { fs } from "sh2perl-runtime";

let WINDOW_W = 800, WINDOW_H = 600;
let PADDLE_SPEED = 0.02, BALL_SPEED = 0.025;
let ball_x = 0.0, ball_y = 0.0;
let ball_vx = BALL_SPEED, ball_vy = BALL_SPEED;
let paddle1_y = 0.0, paddle2_y = 0.0;
let score1 = 0, score2 = 0;

fs.write("/dev/webgl/shader/vertex",
  `attribute vec2 aPosition; ...`);
fs.write("/dev/webgl/shader/fragment",
  `uniform vec3 uColor; ...`);
fs.write("/dev/webgl/buffer/quad", new Float32Array([...]));
fs.write("/dev/webgl/clearcolor", "0.05 0.15 0.05 1.0");

async function gameLoop() {
  while (score1 < 10 && score2 < 10) {
    let keys = await fs.read("/dev/input/keyboard");
    if (/[Ww]/.test(keys)) paddle1_y += PADDLE_SPEED;
    if (/[Ss]/.test(keys)) paddle1_y -= PADDLE_SPEED;

    // AI
    let diff = ball_y - paddle2_y;
    if (diff > 0.02) paddle2_y += PADDLE_SPEED * 0.7;
    else if (diff < -0.02) paddle2_y -= PADDLE_SPEED * 0.7;

    // Ball physics, collisions, scoring...
    // (transpiled from the shell arithmetic and conditionals)

    await fs.write("/dev/webgl/call", "clear");
    // ... draw everything ...
    await fs.write("/dev/webgl/call", "swap");

    await new Promise(r => setTimeout(r, 16));
  }
}

gameLoop();
```

## What Makes This Different

| Other approaches | This approach |
|---|---|
| Write a game in JavaScript/TypeScript | Write a game in **bash** |
| Use a game engine (Three.js, Unity) | Use shell builtins + `/dev/webgl` filesystem |
| Import libraries via npm | `source` scripts, `cat` files into devices |
| API calls like `gl.drawElements(...)` | `echo "draw elements ..." > /dev/webgl/call` |
| Game loop via `requestAnimationFrame` | `while true; do ...; sleep 0.016; done` |

The game is **pure POSIX shell syntax**. Every control structure (`while`,
`if`, `for`), every arithmetic (`$((...))`, `bc`), every I/O operation
(`echo >`, `cat`) is standard bash that sh2perl already parses.

The only non-standard extension is the `/dev/` filesystem — and that's
just a convention for naming the mount points, not a syntax extension.

## What's Actually Feasible Today

The `bc` calls for floating-point arithmetic are the main pain point.
Shell doesn't do floats natively — you'd realistically want a `$((...))`
extension that handles floats, or use `awk`. A cleaner version would use
a hypothetical sh2perl builtin:

```bash
# Instead of:
ball_x=$(echo "$ball_x + $ball_vx" | bc)

# sh2perl could support:
${{ ball_x = ball_x + ball_vx }}
```

But even the `bc` version works — it's just slower. For a Pong game
running at 60 FPS with a transpiler eliminating the subprocess overhead,
the `bc` calls become inline JS arithmetic anyway.

## Two Kinds of Internet Access: Fetch vs. Navigate

The initial vision focused on `cat /http/...` which uses `fetch()` and is
subject to CORS. But the browser has a second channel: **navigation**.

| Mechanism | CORS required? | Returns | Shell command |
|---|---|---|---|
| `fetch()` | ✅ Required | Response body (text, JSON, binary) | `curl`, `cat /http/...` |
| `window.open()` / `<a href>` | ❌ Not needed | Browser navigates to the URL | `open <url>` |

`open` is the browser's native escape hatch:

```bash
# These fail — target site has no CORS:
curl https://en.wikipedia.org/wiki/Bash        # ❌
cat /http/en.wikipedia.org/wiki/Bash           # ❌

# This always works — it's a native navigation:
open https://en.wikipedia.org/wiki/Bash         # ✅
```

The semantic difference:

- `curl` / `cat /http/...` — "give me this data to process in my script"
- `open` — "show this to the user in a tab"

They compose naturally in a script:

```bash
# It handles arbitrary URLs with no CORS concerns.
# "Open the GitHub page for every repo with >1000 stars"
for repo in /mount/github:trending/*/; do
  stars=$(cat "$repo/stargazers_count")
  if [ "$stars" -gt 1000 ]; then
    open "$(cat "$repo/html_url")"
  fi
done

# "Search for a topic, open the most relevant Wikipedia pages"
for page in /wiki/search?q=bash+scripting/*/; do
  open "https://en.wikipedia.org/wiki/$(basename $page)"
done
```

## What Can Be Developed Separately from sh2perl

Most of this vision does **not** require modifying the shell transpiler.
The transpiler's job is one thing: **bash syntax → correct JavaScript**.
Everything else is a runtime library that the generated JS calls into.

### Layer 0: The JavaScript Runtime Library (`sh2runtime`)

This is a standalone npm package. It implements the virtual filesystem
abstractions. The generated JS imports it:

```javascript
import { fs, term, sh } from "sh2perl-runtime";

// Generated code calls these:
let content = await fs.read("/http/example.com/data.json");
await fs.write("/pc/report.csv", data);
let keys = await fs.read("/dev/input/keyboard");
```

This library can be developed independently. It doesn't need the
transpiler at all — you can use it from plain JavaScript right now.

**What's in it:**

| Module | Independent? | Depends on sh2perl? |
|---|---|---|
| `ramfs` — in-memory filesystem | ✅ Yes | ❌ No |
| `localStorageFS` — persistent scratch | ✅ Yes | ❌ No |
| `downloadFS` — `/pc/` write triggers download | ✅ Yes | ❌ No |
| `clipboardFS` — `/clip/` read/write | ✅ Yes | ❌ No |
| `httpFS` — `/http/...` via fetch | ✅ Yes | ❌ No |
| `githubFS` — `/mount/github:...` | ✅ Yes | ❌ No |
| `npmFS` — `/mount/npm:...` | ✅ Yes | ❌ No |
| `inputFS` — `/dev/input/keyboard` | ✅ Yes | ❌ No |
| `webglFS` — `/dev/webgl/*` | ✅ Yes | ❌ No |
| `procFS` — `/proc/cpu`, `/proc/mem` | ✅ Yes | ❌ No |

Each mount handler is a standalone class implementing a small interface:

```typescript
interface VirtualFS {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  list(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
```

You could publish `sh2perl-runtime` on npm today without writing a
single line of transpiler code. It's a browser filesystem library that
happens to pair well with the transpiler.

### Layer 1: The REPL Shell (Terminal UI)

A standalone web app that combines:

- **xterm.js** — terminal emulator UI
- **sh2perl-runtime** — the virtual filesystem
- A **read-eval-print loop** that evaluates commands

Initially this could use a **JavaScript REPL** (no bash syntax):

```javascript
// Type this in the terminal:
> fs.read("https://api.github.com/repos/user/repo/readme")
  .then(console.log)

> await fs.write("/pc/report.csv", "a,b,c\n1,2,3")
  // Your browser downloads report.csv

> fs.list("/mount/npm:lodash")
  .then(files => files.forEach(f => console.log(f)))
```

This works **without sh2perl**. The bash transpilation only becomes
relevant when you want to type bash syntax instead of JavaScript.

### Layer 2: The Transpiler (sh2perl compiled to WASM)

This is the one piece that requires the Rust codebase. Compile
sh2perl to WASM, expose a `bashToJS(code: string) => string` function.

```javascript
import init, { bashToJS } from "sh2perl-wasm";

await init();
let js = bashToJS(`echo "hello world" | grep hello`);
// js = `
//   import { sh } from "sh2perl-runtime";
//   let output = await sh.pipeline([
//     () => sh.exec("echo", ["hello world"]),
//     (input) => sh.exec("grep", ["hello"], { input })
//   ]);
// `
```

### Layer 3: Integration — The Browser Shell

The final product combines all three layers:

```
┌──────────────────────────────────────────┐
│  xterm.js (terminal UI)                  │
│    │                                     │
│    ├ User types bash ──→ sh2perl-wasm    │
│    │                     → generated JS  │
│    │                                     │
│    └ Generated JS calls sh2perl-runtime  │
│        → reads/writes virtual filesystem │
│        → routes to correct mount handler │
│        → displays output in terminal     │
└──────────────────────────────────────────┘
```

### Build Order (Independent Projects)

| Step | Project | Depends on | Delivers |
|---|---|---|---|
| 1 | `sh2runtime` (npm) | Nothing | Virtual FS with ramfs, localStorage, HTTP, GitHub mounts. Usable from plain JS. |
| 2 | Terminal REPL | sh2runtime | xterm.js + JS read-eval-print loop. Full `/dev/` and `/mount/` access from JavaScript. |
| 3 | `sh2perl-wasm` | sh2perl repo | WASM-compiled bash→JS transpiler. Single function: `bashToJS(code)` |
| 4 | Browser bash shell | Steps 2 + 3 | Type bash, run in browser. The full vision. |

**Step 1 is the critical enabler.** It's the foundation everything else
builds on, and it can ship today as a standalone library regardless of
the transpiler's status.

### What Requires the Transpiller

Very little, in terms of features:

| Feature | Needs sh2perl? | Alternative |
|---|---|---|
| Virtual filesystem mounts | ❌ No | JavaScript API: `fs.read()`, `fs.write()` |
| `/dev/webgl` rendering | ❌ No | JS API: `fs.write("/dev/webgl/call", ...)` |
| GitHub repo browsing | ❌ No | JS API: `fs.list("/mount/github:user/repo")` |
| Pipes between commands | ❌ No | JS: `sh.pipeline(...)` runtime function |
| Control flow (if/for/while) | ❌ No | JS already has these |
| `ls`, `cat`, `grep` commands | ❌ No | JS wrappers: `await ls("/tmp")` |
| **Bash syntax instead of JS** | ✅ Yes | Type `if [ -f x ]` instead of `if (await fs.exists("x"))` |

Everything except the last row is a **runtime library concern**, not a
transpiler concern. The transpiler's sole value-add is letting users
write bash syntax. The filesystem, the mounts, the devices, the terminal
— those are all independent.

## Summary

This is a **serious joke**. The syntax is absurd — writing a real-time 3D
game in bash. But the architecture is real:

1. **sh2perl parses bash** — all of it, including functions, variables,
   control flow, arithmetic
2. **Filesystem abstraction** — every `/dev/` path is a mount point to a
   browser API
3. **Transpilation** — shell constructs become equivalent JS with correct
   semantics
4. **Execution** — the browser runs the JS natively with no WASM overhead
   (the compiled bash logic runs at native speed)

The "joke" is the language choice. The "serious" part is that the pipeline
works: shell → AST → IR → JS → browser APIs.

If it were ever built, `pong.sh` would be the weirdest, most delightful
tech demo on the internet: a 3D game rendered via WebGL, controlled by
keyboard input, composable via pipes, scriptable via shell — and it
fits in a terminal scrollback buffer.

---

*See also: [architectural-considerations.md](architectural-considerations.md)*
*for the technical foundation this vision builds upon.*
