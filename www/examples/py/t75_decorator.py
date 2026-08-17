# t75_decorator: @deco() decorator line above a function definition
# deco returns the identity-like first(); native applies first(hello)
# (printing ""), then hello() prints "hi" — stdout matches the
# transpiled deco-call echo + hello call.
# diagnostics: program prints its result to stdout
def first(f):
    print("")
    return f

def deco():
    return first

@deco()
def hello():
    print("hi")

hello()
