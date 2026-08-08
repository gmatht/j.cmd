# Demonstrate complex test expression with backslash continuation
# Parser failed with: Lexer error: Unexpected character: -
[ \( ! -h "$FILE" -a \
    -d "$FILE" \) -o \
    \( -h "$FILE" -a \
    "$(readlink "$FILE")" = "target" \) ]
printf "parsed OK\\n"
