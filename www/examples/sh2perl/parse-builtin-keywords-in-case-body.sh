# Test that builtin commands (set, shift, break, continue) work
# inside case bodies with ;;
case $1 in
  start) shift;;
  stop) set -- stopped;;
  check) echo "checking" ;;
  *) echo "unknown";;
esac
