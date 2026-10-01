# t100_additive_native: the same shape but provably inside the exact
# domain (3 * 1000), so it must STAY on the native int path — the guard
# must not force bigint for every loop-carried accumulator.
s = 0
for i in range(3):
    s = s + 1000
print(s)
