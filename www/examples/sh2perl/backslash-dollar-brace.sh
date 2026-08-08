#!/bin/sh
# Autoconf-style escaped var test: \${$var+y}
# The backslash before $ should escape the dollar
for var in BASH_ENV ENV MAIL
do
    eval test \${$var+y} && unset $var || :
done
printf "parsed OK\\n"
