name="world"
echo "hello $name" | tr a-z A-Z
files=$(ls /tmp)
echo "files: $files"
count=$(echo one; echo two | wc -l)
echo "count=$count"
echo "double $(echo nested) done"
echo "backtick `echo bt` done"
