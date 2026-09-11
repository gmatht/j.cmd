# t89_factor_big: exercise the BigInt arm on values GREATER THAN 2^64 — the
# arm must stay EXACT (Python ints are unbounded). Regression guard for the
# asIntN(64, …) / Number(p1) truncation: if the renderer reads the param as a
# double (Number(p1)) or wraps operands modulo 2^64, a >2^64 n truncates and
# the factor list comes out wrong.
#
# A full all_factors(n) loop is O(sqrt(n)) = O(2^32) for n > 2^64 — infeasible
# for a gate test. So this file trial-divides a >2^64 value over a SMALL
# divisor range (O(100) loop), which still routes n through the BigInt arm
# where the truncation bites. The full all_factors(n) form is kept in
# /tmp/t89_factor_big_full.py for compile-inspection only.
def small_factors(n):
    factors = set()
    for i in range(1, 100):
        if n % i == 0:
            factors.add(i)
    return sorted(list(factors))

# 2^64+1 = 18446744073709551617 (odd). A truncating renderer reads Number(n)
# = 2^64 (even) and wrongly reports 2,4,8,... as factors. Correct: [1].
print(small_factors(2**64 + 1))
print(small_factors(2**100 + 13))
print(small_factors(3**50))
