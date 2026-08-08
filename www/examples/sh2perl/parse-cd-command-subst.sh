# cd with command substitution and || die pattern
cd "$(dirname "$0")"/../.. || die "Could not cd"
printf "parsed OK\\n"
