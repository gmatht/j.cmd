# Double quote unexpected - often in option parsing
# with embedded quotes
OPTIONS_SPEC="\
--branch=<newname> \
"
printf "%s=[%s]\n" OPTIONS_SPEC "${OPTIONS_SPEC:-}"

