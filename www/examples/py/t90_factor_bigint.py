# t90_factor_bigint: factors that EXCEED i64 (2^64+1 = 18446744073709551617)
# computed via a SMALL divisor loop (O(5)) — the factor 18446744073709551617
# is > i64::MAX, so it must be stored/joined as a bigint, not truncated to
# long long. Regression guard for the bigint-factor array/join path.
def factors(n):
    f = []
    for i in [1, 2, 3, 4, 5]:
        if n % i == 0:
            f.append(i)
            f.append(n // i)
    return sorted(f)

print(factors(2**64 + 1))
print(factors(2**100 + 13))
