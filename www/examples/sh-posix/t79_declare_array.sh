# t79_declare_array: declare -a array literal (A1 Bool node)
# diagnostics: program prints its result to stdout
declare -a arr=(1 2)
echo "${arr[0]}"
