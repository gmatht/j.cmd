# t44_background: background job and wait
# diagnostics: program prints its result to stdout
(echo bg) &
wait
echo main
