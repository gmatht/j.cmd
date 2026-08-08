# Test escaped double-quote inside ${...} parameter expansion
val="${val#\"}"
val="${val%\"}"
echo "${val}"
