# t59_until: negated-condition loop (Python has no until)
# diagnostics: program prints its result to stdout
i = 0
while not (i >= 3):
    print("u" + str(i))
    i += 1
