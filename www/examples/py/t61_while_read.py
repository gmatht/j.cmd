# t61_while_read: read-loop over stdin
# diagnostics: program prints its result to stdout
import sys
for line in sys.stdin:
    print("line=" + line.strip())
