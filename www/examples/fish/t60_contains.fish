# t60_contains: grep-in-test idiom -> contains
# diagnostics: program prints its result to stdout
if echo "hello world" | grep world >/dev/null 2>/dev/null
    echo has
else
    echo no
end
if echo "hello world" | grep nope >/dev/null 2>/dev/null
    echo has2
else
    echo no2
end
