#!/bin/sh
# ${db:Status-Abbrev} dpkg format string in parameter expansion
LIBSSL=$(dpkg-query -f '${db:Status-Abbrev}\t${binary:Package}\n' -W 'libssl1.0.?' 2>&1)
echo "$LIBSSL"
