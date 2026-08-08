# Demonstrate shopt -q (quiet) flag before -s/-u option
# Parser failed with: Expected option after shopt, got: Minus
shopt -q -s extglob
shopt -q -u extglob
printf "parsed OK\\n"

echo "done: $?"
