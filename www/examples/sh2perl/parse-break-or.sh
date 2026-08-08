# break followed by ||
while true; do break || exit 1; done
printf "parsed OK\\n"

echo "exit: $?"
