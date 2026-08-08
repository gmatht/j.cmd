# return followed by | in a function
f() {
    return 0 | cat
}
printf "parsed OK\\n"

echo "exit: $?"
