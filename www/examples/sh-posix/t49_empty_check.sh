# t49_empty_check: check for empty string
# diagnostics: program prints its result to stdout
X=""
if [ -z "$X" ]; then
    echo empty
fi
