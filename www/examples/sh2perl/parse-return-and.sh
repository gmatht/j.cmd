# return followed by && in a function
f() {
    true && return && echo done
}

echo "exit: $?"
