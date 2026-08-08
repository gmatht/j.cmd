# ${@:3} substring expansion
set -- "$1" "$2" "$3"
echo "${@:3}"
