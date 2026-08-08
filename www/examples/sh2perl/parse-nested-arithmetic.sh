# Nested $(( ... )) arithmetic inside arithmetic
x=$(( ($n + 1) % 3 ))
printf "%s=[%s]\n" x "${x:-}"

