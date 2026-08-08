#!/bin/sh
# Complex test expression with escaped parentheses for grouping,
# and -a/-o logical operators across multiple lines with backslash
# continuations. The parser must correctly handle \( and \) inside [ ].
if [ \( ! -h "/path" -a \
        -d "/path" -a \
        -f "/path/file" \) -o \
     \( -h "/path" -a \
        "$(readlink "/path")" = "target" \) ] &&
   dpkg --compare-versions -- "1.0" le "2.0"; then
    echo "complex condition met"
fi
