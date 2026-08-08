#!/bin/bash

# Complex backtick examples
d=$(mktemp -d)
cd "$d" || exit 1
# This file demonstrates complex usage patterns with backticks

echo "=== Complex Backtick Examples ==="

# Nested backticks
nested_result=`echo "Three wells: \`yes well | head -3\`"`
echo "Nested backticks: $nested_result"

# Backticks in arithmetic
count=`ls -1 | wc -l`
echo "File count: $count"

# Backticks in conditional
current_user=`echo root`
if [ "$current_user" = "root" ]; then
    echo "Running as root"
else
    echo "Not running as root"
fi

# Backticks in case statement
system_name='Darwin'
case $system_name in
    Linux)
        echo "Running on Linux"
        ;;
    Darwin)
        echo "Running on macOS"
        ;;
    *)
        echo "Running on other system"
        ;;
esac

# Backticks in function
get_file_size() {
    local file=$1
    local size=`wc -c < "$file"`
    echo "File $file has $size bytes"
}

get_file_size 000__01_file_directory_operations.sh

# Backticks in array
files=(`ls -1 *.sh examples/*.sh 2>/dev/null`)
echo "Shell scripts found: ${#files[@]}"
for file in "${files[@]}"; do
    echo "  - $file"
done

# Backticks with process substitution
echo -e "apple\nbanana\ncherry" > file1.txt
echo -e "banana\ncherry\ndate" > file2.txt
process_result=`comm -23 <(sort file1.txt) <(sort file2.txt)`
echo "Process substitution result:"
echo "$process_result"

# Backticks with here strings
here_string_result=`tr 'a-z' 'A-Z' <<< "hello world"`
echo "Here string result: $here_string_result"

# perl command with backticks
#PERL_MUST_NOT_CONTAIN `perl
perl_result=`perl -e 'print "Hello from Perl\n"'`
echo "Perl result: $perl_result"

# Cleanup
rm -f file1.txt file2.txt

echo "=== Complex Backtick Examples Complete ==="
cd /
rm -rf "$d"

