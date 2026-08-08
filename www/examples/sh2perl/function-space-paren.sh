#!/bin/sh
# Function defined with space before parentheses (POSIX style)
# This was a parse error: "Unexpected token in brace expansion"
my_func () {
  echo "hello"
}
my_func

echo "done: $?"
