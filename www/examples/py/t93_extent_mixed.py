# t93_extent_mixed: a list with both i64 and bigint elements, consumed by
# sorted() — the extent partition keeps the i64 bulk on a native sort
# (-bigint, i64, +bigint; the i64 elements never do an mpz compare).
xs = [5, -2**100, 3, 2**100, 1, -2**64, 4, 0]
print(sorted(xs))
ys = [2**64 + 3, 7, 1, 5, -2**63, 9, 2**200]
print(sorted(ys))
print(max(xs))
print(min(xs))
print(sum(xs))
