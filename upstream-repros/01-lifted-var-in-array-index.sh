#!/usr/bin/env bash
# ── BUG (LIVE): a natively-lifted variable used as an ARRAY INDEX ──
#
# `cell` is assigned from an arithmetic expression, so the emitter lifts
# it to a native JS `let` (and assigns it natively). The indexed write
# `lookup[$cell]` is emitted as `sh2.setVar("lookup[$cell]", -1)` — a
# STRING whose `$cell` the RUNTIME expands from the sh2 STORE. The store
# has no entry for a natively-lifted variable, so the expansion is empty
# and the key becomes "lookup[]": the write lands on the wrong key and
# the read below sees nothing.
#
# Expected (bash):       direct: [-1]
# Transpiled (buggy):    direct: []
#
# Fix belongs in the emitter: a name it lifted natively must not also be
# referenced via a `$name` string that expects store expansion — emit an
# interpolated name (`lookup[${cell}]`) for native bindings, and keep the
# `arr[$var]` string form only for variables that live in the store.
lookup=()
a=3
b=4
cell=$((b * 16 + a))
lookup[$cell]=-1
echo "direct: [${lookup[67]}]"
