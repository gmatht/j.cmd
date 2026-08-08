# ${var%%pattern} and ${var#pattern} parameter expansion
path="/usr/local/bin"
echo "${path%%/*}"
echo "${path#*/}"
