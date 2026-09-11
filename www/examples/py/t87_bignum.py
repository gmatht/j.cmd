# t87_bignum: Python bigint arithmetic beyond 64 bits
# diagnostics: program prints its result to stdout
x = 2 ** 100
print(x)
print(x + 1)
print(x * 3)
print(x % 7)
print(x // 7)
print(10 ** 30 + 123456789)
print((2 ** 64) ** 2)
print(2 ** 64 - 1)
print(123456789012345678901234567890 + 1)
print(-x)
print(x // 1000000007)
print(x % 1000000007)
