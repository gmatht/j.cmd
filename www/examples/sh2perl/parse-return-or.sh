# return followed by || in a function
f() {
    false && return || return 1
}

echo "exit: $?"
