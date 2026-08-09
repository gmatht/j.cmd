# t55_array_elem: array element write (zsh 1-based)
# diagnostics: program prints its result to stdout
a=(a b c)
a[2]=X
echo $a[1] $a[2] $a[3]
