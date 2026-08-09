# t60_contains: grep-in-test idiom -> contains
# diagnostics: program prints its result to stdout
if echo "hello world" | grep world >/dev/null 2>/dev/null; then echo "has"; else echo "no"; fi
if echo "hello world" | grep nope >/dev/null 2>/dev/null; then echo "has2"; else echo "no2"; fi
