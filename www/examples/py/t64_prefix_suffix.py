# t64_prefix_suffix: prefix & suffix removal
# diagnostics: program prints its result to stdout
x = "hello"
print(x.removeprefix("he"))
print(x.removesuffix("lo"))
print(x.rsplit("l", 1)[1])
print(x[:x.find("l")])
