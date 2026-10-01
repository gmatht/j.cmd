# t102_dual_guard — the entry-guarded dual arm (docs/AUTO_CYTHON.md §11).
#
# Each function's integers are unprovable ONLY because the parameter is (`n` is
# ⊤ at the call site, so `i * n` is ⊤, so the accumulator is ⊤). The pass emits a
# fast twin typed under a hypothesis + a guard that discharges it, so:
#
#   * in-range calls take the C-typed arm (that is the point of the transform);
#   * every out-of-range call MUST still produce the exact Python answer. Those
#     are the traps below: a missing/broken guard makes `scaled(2 ** 100)` wrap or
#     raise, and makes `scaled(2.5)` a C integer instead of a float. The gate
#     (coverage/py2cy-parity.sh) compiles this file with `cython --embed` and
#     requires CPython-identical stdout, so a guard bug cannot pass silently.
#
# `scaled` also pins the guard EDGE: `n * 19` for n = 2147483647 stays inside the
# proved interval, so the last in-range value must be exact, and the first value
# past it takes the exact arm.


def scaled(n):
    t = 0
    for i in range(1000):
        t = (t + i * n) % 1000000007
    return t


# The widest hypothesis that still proves the body: only `n % m` needs a
# non-negative int, so the guard covers the whole non-negative i64 range.
def wrap(n):
    t = n % 1000000007
    return t


print(scaled(0))
print(scaled(1))
print(scaled(1000))
print(scaled(2147483647))
print(scaled(2147483648))
print(scaled(2 ** 100))
print(scaled(2.5))
print(scaled(-3))
print(wrap(0))
print(wrap(12345))
print(wrap(2 ** 63 - 1))
print(wrap(2 ** 63))
print(wrap(-7))
