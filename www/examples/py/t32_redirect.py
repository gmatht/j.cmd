# t32_redirect: redirect output to a file
# diagnostics: program prints its result to stdout
with open("/tmp/f", "w") as fh:
    fh.write("data\n")
print("wrote")
