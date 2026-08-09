# t63_array_split: unquoted expansion in an array literal field-splits
# diagnostics: program prints its result to stdout
x="a b"
arr=($x)
echo "n=${#arr[@]}"
echo "${arr[0]}|${arr[1]}"
