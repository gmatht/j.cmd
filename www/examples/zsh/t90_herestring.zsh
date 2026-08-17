# t90_herestring: here-string redirect — tree-sitter-zsh herestring_redirect
# (`<<< word` feeds word + newline to the command's stdin; the word is
# interpolated). Distinct from t43_heredoc (heredoc_redirect, `<<EOF`).
# diagnostics: program prints its result to stdout
v=hello
cat <<< "$v world"
