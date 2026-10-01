# t101_tier_overflow_replay: forces the i64 tier to overflow inside a
# speculative fast arm, then the exact GMP replay. The tiered var's ENTRY
# value is nonzero, so a replay that started from the stale mpz slot
# (never written while the mirror was authoritative) would print 2e19
# instead of the +1-exact 20000000000000000001.
s = 1
i = 0
while i < 5:
    s = s + 4000000000000000000
    i = i + 1
print(s)
