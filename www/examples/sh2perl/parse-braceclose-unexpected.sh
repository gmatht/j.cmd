# Unexpected BraceClose - often from unbalanced braces in
# function definitions with complex variable expansions
fmt_underline() {
  echo "test"
}

echo "exit: $?"
