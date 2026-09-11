# t88_factor53: all_factors with inputs ALWAYS < 2^53 (i53-safe).
# The point: the compiler should be able to prove the loop never needs
# BigInt and emit a plain-Number (i53) loop — no BigInt, no dual version.
def all_factors(n):
    factors = set()
    for i in range(1, int(n**0.5) + 1):
        if n % i == 0:
            factors.add(i)
            factors.add(n // i)
    return sorted(list(factors))

print(all_factors(12))          # [1, 2, 3, 4, 6, 12]
print(all_factors(100))         # [1, 2, 4, 5, 10, 20, 25, 50, 100]
print(all_factors(2147483645))  # < 2^53
print(all_factors(67108837))    # < 2^53
print(all_factors(9007199254740991))  # 2^53 - 1, still i53-safe
