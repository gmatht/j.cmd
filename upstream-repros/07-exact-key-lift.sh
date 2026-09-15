#!/usr/bin/env bash
# ─── 07 — an index var used ONLY as exact keys lifts without moving storage ──
# Class: lift eligibility. Status: FIXED (guard narrowing).
#
# `k` is referenced only as an EXACT array key (`${a[$k]}` → the runtime
# call `sh2.arrayIndex("a", "$k")`). Lifting `k` to a native binding and
# rewriting the key to the bare Identifier (`arrayIndex("a", k)`) is
# storage-neutral: the array itself stays in the store, so the
# whole-array `${a[*]}` read keeps working (contrast 05, where the index
# var also appears in an index NAME — lifting that moves the element
# writes native while the star still reads the store, so the lift must
# stay off). Expected: the transpiled shell prints what bash prints AND
# the generated JS carries `k` natively (see __lift-key-test.mjs).
a=()
a[1]=x
a[2]=y
pick() { k=$1; echo "elem=[${a[$k]}]"; }
pick 2
echo "star=[${a[*]}]"
