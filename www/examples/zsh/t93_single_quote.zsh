# t93_single_quote: single-quoted string literal — tree-sitter-zsh raw_string
# (`'...'`, the fully-literal quote form: content taken verbatim, no
# interpolation, no escape processing). Distinct from t09 (double quotes,
# interpolated) and t88 ($'...' ansi_c_string).
# diagnostics: program prints its result to stdout
echo 'hello world'
msg='literal text'
echo $msg
echo '$msg'
