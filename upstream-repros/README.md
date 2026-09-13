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
| `01-lifted-var-in-array-index.sh` | **OPEN** | a natively-lifted variable used as an array index writes to the wrong key (`lookup[]` instead of `lookup[67]`) |
| `02-param-strip-live-value.sh` | fixed | `${v#pat}` of a lifted variable came back empty |
| `03-single-quoted-payload.sh` | fixed | a single-quoted `$var` payload was rewritten as an expansion |

## Why stdout, not assertions

The failures are *semantic*: the program runs, prints something plausible,
and only differs from bash in a value. Comparing stdout against real bash
is the strongest statement available and needs no in-test expectations to
rot. (For the same reason the project compares pancurses against the
ratatui backend rather than asserting "some output appeared".)
