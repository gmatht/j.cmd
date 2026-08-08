#!/bin/bash
# Dollar-single-quoted string $'...' pattern.
IFS=$'\n\t'
printf 'IFS value (hex)='; printf '%q' "$IFS"; printf '\n'
