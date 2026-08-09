# t50_file_test: test a file exists
# diagnostics: program prints its result to stdout
import os
if os.path.exists("/etc/passwd"):
    print("exists")
