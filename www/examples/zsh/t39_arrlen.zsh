# t39_arrlen: array length
# diagnostics: program prints its result to stdout
# NOTE: zsh's idiomatic `$#a` does not round-trip through the A1 contract —
# the bash-shaped core parses it as `$#` + literal `a` (see FRONTEND.md).
# `${#a[@]}` is the A1-representable zsh form: it lowers to arrayLen(a).
a=(1 2 3)
echo ${#a[@]}
