def all_factors(n):
    factors = set()
    for i in range(1, int(n**0.5) + 1):
        if n % i == 0:
            factors.add(i)
            factors.add(n // i)
    return sorted(list(factors))

old_factors=all_factors(10)
print(all_factors(12)) # Output: [1, 2, 3, 4, 6, 12]
print(all_factors(2147483645))
print(all_factors(67108847*67108837))
print(all_factors(67108837))
print(old_factors)
