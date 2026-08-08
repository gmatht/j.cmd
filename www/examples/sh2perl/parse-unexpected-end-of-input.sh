# Unexpected end of input - often from incomplete if/for/while
# This is a minimal example that should trigger the issue
if true; then
  echo "incomplete"

echo "exit: $?"
