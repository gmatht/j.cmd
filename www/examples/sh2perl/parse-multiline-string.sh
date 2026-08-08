# Multi-line string with backslash continuation
OPTIONS_SPEC="\
--help \
--version \
"
printf "%s=[%s]\n" OPTIONS_SPEC "${OPTIONS_SPEC:-}"

