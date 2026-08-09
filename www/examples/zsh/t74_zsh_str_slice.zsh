# t74_zsh_str_slice: zsh string slice ${var:off:len}
# diagnostics: program prints its result to stdout
s="hello world"
echo "${s:6:5}"
echo "${s:0:5}"
