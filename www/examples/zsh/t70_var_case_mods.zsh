# t70_var_case_mods: zsh-native ${var:l} / ${var:u} case modification
# diagnostics: program prints its result to stdout
# DRIVER: emits valid A1 but the ESTree runner renders it wrong — the
# frontend owns harness/* so this is a fixable gate gap, not a contract gap.
x="Hello World"
echo "${x:l}"
echo "${x:u}"
