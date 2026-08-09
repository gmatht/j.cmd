# t68_case_glob: pattern dispatch via if/elif
# diagnostics: program prints its result to stdout
s = "hello"
if s.startswith("h"):
    print("star")
elif "l" in s or "x" in s:
    print("alt")
s = "axl"
if s.startswith("h"):
    print("star2")
elif "l" in s or "x" in s:
    print("alt2")
