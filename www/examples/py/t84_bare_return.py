# t84_bare_return: bare return exits a function early (A1 Return node)
# diagnostics: program prints its result to stdout
def f():
    return
    print("unreachable")

f()
print("after")
