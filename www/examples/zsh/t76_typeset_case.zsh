# t76_typeset_case: zsh typeset -l / -u case conversion
# diagnostics: program prints its result to stdout
typeset -l low="HELLO"
typeset -u up="world"
echo "$low"
echo "$up"
