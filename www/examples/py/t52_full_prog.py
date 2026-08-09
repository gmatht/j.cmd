# t52_full_prog: full program combining constructs
# diagnostics: program prints its result to stdout
def greet(name):
    return "hello " + name
names = ["a", "b"]
for n in names:
    print(greet(n))
