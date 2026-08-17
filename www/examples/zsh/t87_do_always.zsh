# t87_do_always: always clause inside a do...done loop
# (tree-sitter always_statement; zsh parses `always` as a plain command
# in this position — the always-part runs as ordinary loop-body commands)
# diagnostics: program prints its result to stdout
i=0
while (( i < 2 )); do
    echo "body $i"
    ((i++))
always
    echo "always-part"
done
echo after
