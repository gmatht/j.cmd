# upstream-repros — minimal reproducers for transpiler/runtime bugs

Each `NN-*.sh` is a **self-contained** example of a bug hit while building
mimecroft. The acceptance rule is exactly bash's: *the transpiled shell
must print what real bash prints*, so each reproducer is its own test.

    node ../run-upstream-repros.mjs           # all
    node ../run-upstream-repros.mjs 02        # one

Exit 0 = all match real bash (bugs fixed). Exit 1 = at least one still
differs = a bug report ready to send upstream, printed as
`bash=… transpiled=…` side by side.

`../__upstream-guard-test.mjs` runs the same reproducers in the deploy
gate. Reproducers known to be OPEN are listed there as `KNOWN_OPEN`, so a
still-unfixed upstream bug cannot block an unrelated deploy — but a bug
that WAS fixed can never silently come back.

| reproducer | status | summary |
|---|---|---|
| `01-lifted-var-in-array-index.sh` | **OPEN (A1 frontend)** | indexed write with a computed key: the A1 keeps the target as the raw string `lookup[$cell]` AND drops the `cell=$((…))` statement as dead code (its only use hides inside that string), so the runtime expands an unset `$cell` and the key collapses to `lookup[]` |
| `02-param-strip-live-value.sh` | fixed | `${v#pat}` of a lifted variable came back empty |
| `03-single-quoted-payload.sh` | fixed | a single-quoted `$var` payload was rewritten as an expansion |

## 01: the fix has two halves

*Toolkit half (LANDED here, `src/lower.js`
`interpolateNativeIndexNames`)*: when the index variable's home really IS
a native JS binding (assigned natively, never store-written), emit an
interpolated name (`\`lookup[${cell}]\``) so the value is read from the
binding instead of an empty store. This fixed mimecroft's mime cubes
(the 3D payload now draws the cube at the NEW cell). Names that ARE
store-written (mimecroft's `map_set` `mi=$1` → `sh2.vars.mi = …`) must
NOT be interpolated or the write lands on a dead placeholder — verified:
doing it anyway makes `gen_maze` spin forever.

*Frontend half (STILL OPEN, `shir.rs`)*: the A1 must not hide a variable
use inside an indexed target's rendered string. `cell=$((b*16+a))` is
eliminated as dead because its only use is the literal target
`"lookup[$cell]"`; the A1 should carry the key as a real expression (an
indexed target) so liveness sees the use. Reproducer 01 keeps failing
until that lands — with the key expression preserved, even the
toolkit half becomes unnecessary for this shape.

## Why stdout, not assertions

The failures are *semantic*: the program runs, prints something plausible,
and only differs from bash in a value. Comparing stdout against real bash
is the strongest statement available and needs no in-test expectations to
rot. (For the same reason the project compares pancurses against the
ratatui backend rather than asserting "some output appeared".)
