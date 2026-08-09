# t71_var_name_mods: zsh-native ${var:t} basename / ${var:h} dirname
# diagnostics: program prints its result to stdout
# DRIVER: same class as t70 — runner-side lowering gap.
p="/tmp/data/file.txt"
echo "${p:t}"
echo "${p:h}"
