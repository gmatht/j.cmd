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

`../__redirect-target-test.mjs` is the repo-local unit half for 08: it
pins the exact generated-JS shape (the `captureWords()` array reaching
`writeFile`) *and* the end-to-end behaviour, so the defect stays visible
even while the runtime side is still being worked on. The upstream half
lives at `sh2perl/bash_tests/redirect_target_ambiguity.sh` (same four
cases, driven straight through `otranspiler --target js` + `js-runner`).

| reproducer | status | summary |
|---|---|---|
| `01-lifted-var-in-array-index.sh` | fixed (toolkit; upstream ideal open — see §01) | indexed write with a computed key: the A1 keeps the target as the raw string `lookup[$cell]` AND drops the `cell=$((…))` statement as dead code (its only use hides inside that string), so the runtime expands an unset `$cell` and the key collapses to `lookup[]` |
| `02-param-strip-live-value.sh` | fixed | `${v#pat}` of a lifted variable came back empty |
| `05-param-only-use-in-index.sh` | fixed | a function param whose only use is inside an array-index name (`arr[$p]`): the assignment is dropped as dead code AND the positional args are renumbered, so `tpx[1]`/`tpx[2]` stay empty and only one element survives (mimecroft: only 1 of 10 artifacts could be claimed) |
| `03-single-quoted-payload.sh` | fixed | a single-quoted `$var` payload was rewritten as an expansion (end-to-end pins: `__frag-stage-test.mjs` byte-compares the staged fragment program; `__mime-test.mjs` checks the booted game staged `putb $b`) |
| `06-sparse-array-star.sh` | fixed | `${a[*]}`/`${a[@]}` rendered unassigned holes as empty fields instead of skipping them |
| `07-exact-key-lift.sh` | fixed (pins the reinstated lift) | an index var used ONLY as exact keys (`arrayIndex("a", "$k")`) lifts to a native binding (bare-Identifier key) while the same array's `${a[*]}` keeps reading the store — the storage-neutral subset of the week-ago lift, reinstated with 05 as the boundary proof |
| `08-unquoted-cmdsub-redirect-target.sh` | **OPEN** | an unquoted `$(…)` used as a redirect TARGET: the JS backend emits `fs.writeFile(sh2.captureWords(…), …)` — handing the word-SPLITTER's array to the path argument. bash's rule is word-splitting: ONE word → the file is created; ZERO or MANY → `ambiguous redirect`, status 1, no file. The emitter does neither, so a one-word target errors (`path.startsWith is not a function`) and two words collapse to `alpha,beta`. This is the mechanism behind a 130-byte junk file in the repo root named after a fragment of mimecroft's shader source (see the reproducer header). Local unit half: `__redirect-target-test.mjs` |

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

*Frontend half (STILL OPEN upstream, `shir.rs` — the toolkit workaround below is what the gate pins)*: the A1 must not hide a variable
use inside an indexed target's rendered string. `cell=$((b*16+a))` is
eliminated as dead because its only use is the literal target
`"lookup[$cell]"`; the A1 should carry the key as a real expression (an
indexed target) so liveness sees the use. The reproducer passes today
via the toolkit half; with the key expression preserved upstream, even
the toolkit half becomes unnecessary for this shape.

## Why stdout, not assertions

The failures are *semantic*: the program runs, prints something plausible,
and only differs from bash in a value. Comparing stdout against real bash
is the strongest statement available and needs no in-test expectations to
rot. (For the same reason the project compares pancurses against the
ratatui backend rather than asserting "some output appeared".)
