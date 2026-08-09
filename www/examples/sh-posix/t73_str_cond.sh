# t73_str_cond: [ -z ] and [ -n ] string tests
# diagnostics: program prints its result to stdout
s=""
[ -z "$s" ] && echo empty
[ -n "x" ] && echo nonempty
