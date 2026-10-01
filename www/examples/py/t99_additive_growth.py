# t99_additive_growth: a loop-carried additive accumulator whose value
# leaves the exact int domain (the additive sibling of the multiplicative
# growth guard). `s = s + 4e18` three times = 1.2e19 > i64::MAX, so a
# native i64 accumulator would wrap; the frontend must force the exact
# (bigint) domain. Found by docs/PY_BENCH.md's review of the growth guard.
s = 0
for i in range(3):
    s = s + 4000000000000000000
print(s)
