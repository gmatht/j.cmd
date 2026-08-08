# SameFile redirect operator confusion
# ${var%pattern} can be misinterpreted as >& redirect
echo "${PATH%%:*}"
