# t88_ansi_c_string: $'...' ANSI-C quoted string
# (tree-sitter ansi_c_string; the frontend consumes the quoted content
# raw, so escape-free content is the byte-identical round-trip — real
# escapes (\n etc.) are unescaped by the core at emit and by zsh 5.9 at
# runtime, which the raw-text emit cannot match)
# diagnostics: program prints its result to stdout
echo $'hello world'
name=$'zsh'
echo "from $name"
