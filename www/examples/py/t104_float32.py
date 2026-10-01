# t104_float32: float variables incl. binary32-exact values
# diagnostics: program prints its result to stdout
# NOTE: float literals directly in print args (`print(100.0)`) and float
# aug-assign RHS (`h += 0.25`) do not lower yet (frontend word-position
# gap) — spelled via variables and plain assigns instead.
x = 2.5
y = x + 1
print(y)
print(x * 2)
print(0.1 + 0.2)
h = 1.5
h = h + 0.25
print(h)
c = 100.0
print(c)
