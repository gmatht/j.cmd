# t72_one_based_array: zsh 1-based array access (frontend normalizes to 0-based)
# diagnostics: program prints its result to stdout
a=(x y z)
echo $a[1]
echo $a[3]
