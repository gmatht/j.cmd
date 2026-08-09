# t49_empty_check: check for empty string
# diagnostics: program prints its result to stdout
x=""
if [[ -z $x ]]; then
    echo empty
fi
