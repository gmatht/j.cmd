#!/bin/bash

# Output and formatting commands with backticks
# This file demonstrates using backticks with output and formatting commands

echo "=== Output and Formatting Commands ==="

# echo command with backticks
#PERL_MUST_NOT_CONTAIN `echo
echo_result=`echo "Hello from backticks"`
echo "Echo result: $echo_result"

# printf command with backticks
#PERL_MUST_NOT_CONTAIN `printf
printf_result=`printf "Number: %d, String: %s\n" 42 "test"`
echo "Printf result: $printf_result"

echo "=== Compression Commands ==="

# gzip command with backticks
#PERL_MUST_NOT_CONTAIN `gzip
#echo "test content for compression" > test_compress.txt
#gzip_result=`gzip test_compress.txt && echo "Compression successful"`
#echo "Gzip result: $gzip_result"

# zcat command with backticks
#PERL_MUST_NOT_CONTAIN `zcat
#zcat_result=`zcat test_compress.txt.gz`
#echo "Zcat result: $zcat_result"

echo "=== Network Commands ==="

# wget command with backticks
#PERL_MUST_NOT_CONTAIN `wget
# wget_result=`wget -qO- http://httpbin.org/get | head -1`
# echo "Wget result: $wget_result"

# curl command with backticks
#PERL_MUST_NOT_CONTAIN `curl
# curl_result=`curl -s http://httpbin.org/get | head -1`
# echo "Curl result: $curl_result"

echo "=== Process Management Commands ==="

# kill command with backticks (though it doesn't produce output)
#PERL_MUST_NOT_CONTAIN `kill
# kill_result=`kill -0 $$ && echo "Process exists"`
# echo "Kill result: $kill_result"

# nohup command with backticks
#PERL_MUST_NOT_CONTAIN `nohup
# nohup_result=`nohup echo "background process" 2>&1`
# echo "Nohup result: $nohup_result"

# nice command with backticks
d=$(mktemp -d)
cd "$d" || exit 1
#PERL_MUST_NOT_CONTAIN `nice
#nice_result=`nice echo "low priority process"`
#echo "Nice result: $nice_result"

echo "=== Checksum Commands ==="

# sha256sum command with backticks
#PERL_MUST_NOT_CONTAIN `sha256sum
echo "test content" > test_checksum.txt
sha256_result=`sha256sum test_checksum.txt`
echo "SHA256 result: $sha256_result"

# sha512sum command with backticks
#PERL_MUST_NOT_CONTAIN `sha512sum
sha512_result=`sha512sum test_checksum.txt`
echo "SHA512 result: $sha512_result"

# strings command with backticks
#PERL_MUST_NOT_CONTAIN `strings
strings_result=`strings test_binary.txt | head -3`
echo "Strings result:"
echo "$strings_result"

echo "=== I/O Redirection Commands ==="

# tee command with backticks
#PERL_MUST_NOT_CONTAIN `tee
tee_result=`echo "test output" | tee test_tee.txt`
echo "Tee result: $tee_result"

echo "=== Perl Command ==="

# perl command with backticks
#PERL_MUST_NOT_CONTAIN `perl
perl_result=`perl -e 'print "Hello from Perl\n"'`
echo "Perl result: $perl_result"

# Cleanup
rm -f test_checksum.txt test_tee.txt
cd /
rm -rf "$d"

