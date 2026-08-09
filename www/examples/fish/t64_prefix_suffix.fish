# t64_prefix_suffix: prefix & suffix removal
# diagnostics: program prints its result to stdout
set x hello
string replace -r '^he' '' -- $x
string replace -r 'lo$' '' -- $x
string replace -r '^.*l' '' -- $x
string replace -r 'l.*$' '' -- $x
