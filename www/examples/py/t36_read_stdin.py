# t36_read_stdin: read a line from stdin
# diagnostics: program prints its result to stdout
import sys
line = sys.stdin.readline()
print("got " + line.strip())
