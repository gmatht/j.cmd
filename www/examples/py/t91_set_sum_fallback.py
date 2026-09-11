# t91_set_sum_fallback: a set of ints where only ONE element needs a
# bigint, but summing the small (i53-safe) subset still overflows 2^53 —
# so the sum-reduction must leave the narrow domain and widen. Regression
# guard (core-requests/py-sh-go-20260909-split-set-union.md): the
# accumulator must not wrap mod 2^64 (or round past 2^53) when a single
# element is a BigInt.
#
# RESOLVED (2026-09-09): the full BigInt-accumulator fix landed. The
# frontend emits `Cast(Int64, …)` (the "coerce to exact BigInt" marker)
# for bigint-domain reads of int/big loop vars, and the core
# (`shir::exact_bigint_var_read` in `arith_cast_to_estree`) renders a
# non-C-typed / non--true64 / non-slot / non-wide-arm var arg EXACTLY
# (`BigInt(var || 0)`) with NO `asIntN(64, …)` wrap — so the loop body is
# `total = BigInt(total || 0) + BigInt(x || 0)`, exact for numbers up to
# 2**100. The output matches python3 (1267650600228256423094467428346).
#
# The split-set speculative narrow-then-wide two-loop fallback (fast
# Number path over the small partition, mid-loop switch to BigInt on
# overflow) is still design/future work; this file guards the exact-sum
# correctness regardless of which optimization eventually lands. The
# slot-homing fix (an RMW accumulator whose RHS can be a bigint is not
# homed in a BigInt64Array slot, where it would wrap mod 2^64) is also in.
s = set()
s.add(9007199254740991)  # 2^53 - 1
s.add(9007199254740990)
s.add(9007199254740989)
s.add(2 ** 100)          # the only bigint element
total = 0
for x in s:
    total += x
print(total)
