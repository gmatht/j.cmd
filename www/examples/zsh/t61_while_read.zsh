# t61_while_read: while-read loop over a pipe
# diagnostics: program prints its result to stdout
printf "aa\nbb\n" | while read line; do echo "line=$line"; done
