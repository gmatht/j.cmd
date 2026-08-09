# t56_array_append: array append
# diagnostics: program prints its result to stdout
arr=(a b)
arr+=(c d)
echo "${arr[0]}|${arr[1]}|${arr[2]}|${arr[3]}"
