# t62_word_split: unquoted expansions field-split (A1 split marker)
# diagnostics: program prints its result to stdout
x="a b"
echo $x
printf "<%s>\n" $x
for w in $x; do echo "[$w]"; done
printf "<%s>\n" "$x"
