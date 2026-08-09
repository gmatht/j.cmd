# t42_global_mut: function mutates a global
# diagnostics: program prints its result to stdout
g = 0
def f():
    global g
    g = 1
f()
print(g)
