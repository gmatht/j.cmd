# t44_background: background job and wait
# diagnostics: program prints its result to stdout
sleep 1 &
wait
echo main
