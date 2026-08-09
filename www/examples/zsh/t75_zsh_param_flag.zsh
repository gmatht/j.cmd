# t75_zsh_param_flag: ${var:-default} and ${var:=assign} zsh forms
# diagnostics: program prints its result to stdout
empty=""
echo "${empty:-fallback}"
unset opt
echo "${opt:=assigned}"
echo "$opt"
