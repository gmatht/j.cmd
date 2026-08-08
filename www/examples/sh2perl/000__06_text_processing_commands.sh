#!/bin/bash

# Text processing commands with backticks
# This file demonstrates using backticks with text manipulation commands

echo "=== Text Processing Commands ==="

# cat command with backticks
#PERL_MUST_NOT_CONTAIN `cat
file_content=`cat src/main.rs | head -5`
echo "First 5 lines of main.rs:"
echo "$file_content"

# grep command with backticks
#PERL_MUST_NOT_CONTAIN `grep
grep_result=`grep -n "fn" src/main.rs`
echo "Lines containing 'fn':"
echo "$grep_result"

# sed command with backticks
#PERL_MUST_NOT_CONTAIN `sed
sed_result=`echo "Hello World" | sed 's/World/Universe/'`
echo "Sed result: $sed_result"

# awk command with backticks
#PERL_MUST_NOT_CONTAIN `awk
awk_result=`echo "1 2 3 4 5" | awk '{print $1 + $2}'`
echo "Awk sum result: $awk_result"

# sort command with backticks
#PERL_MUST_NOT_CONTAIN `sort
sort_result=`echo -e "zebra\napple\nbanana" | sort`
echo "Sorted words:"
echo "$sort_result"

# uniq command with backticks
#PERL_MUST_NOT_CONTAIN `uniq
uniq_result=`echo -e "apple\napple\nbanana\nbanana\ncherry" | uniq`
echo "Unique words:"
echo "$uniq_result"

# wc command with backticks
#PERL_MUST_NOT_CONTAIN `wc
word_count=`echo "Hello World" | wc -w`
line_count=`echo -e "line1\nline2\nline3" | wc -l`
echo "Word count: $word_count"
echo "Line count: $line_count"

# head command with backticks
#PERL_MUST_NOT_CONTAIN `head
head_result=`seq 1 10 | head -3`
echo "First 3 numbers: $head_result"

# tail command with backticks
#PERL_MUST_NOT_CONTAIN `tail
tail_result=`seq 1 10 | tail -3`
echo "Last 3 numbers: $tail_result"

# cut command with backticks
#PERL_MUST_NOT_CONTAIN `cut
cut_result=`echo "apple:banana:cherry" | cut -d: -f2`
echo "Second field: $cut_result"

# paste command with backticks
#PERL_MUST_NOT_CONTAIN `paste
echo -e "1\n2\n3" > temp1.txt
echo -e "a\nb\nc" > temp2.txt
paste_result=`paste temp1.txt temp2.txt | sed 's/\t/ /g'`
echo "Pasted columns:"
echo "$paste_result"
rm -f temp1.txt temp2.txt

# comm command with backticks
#PERL_MUST_NOT_CONTAIN `comm
echo -e "apple\nbanana\ncherry" > file1.txt
echo -e "banana\ncherry\ndate" > file2.txt
comm_result=`comm -12 file1.txt file2.txt`
echo "Common lines:"
echo "$comm_result"

# diff command with backticks
#PERL_MUST_NOT_CONTAIN `diff
diff_result=`diff file1.txt file2.txt`
echo "File differences:"
echo "$diff_result"

# tr command with backticks
#PERL_MUST_NOT_CONTAIN `tr
tr_result=`echo "HELLO WORLD" | tr 'A-Z' 'a-z'`
echo "Lowercase: $tr_result"

# xargs command with backticks
#PERL_MUST_NOT_CONTAIN `xargs
xargs_result=`echo "1 2 3" | xargs -n1 echo "Number:"`
echo "Xargs result:"
echo "$xargs_result"

# Cleanupcd
rm -f file1.txt file2.txt

