# Test that ;; is handled inside case bodies with builtin commands (shift, set, etc.)
case $1 in
  --dryrun) dryrun=t; shift ;;
  a) set -- hello ;;
  b) dryrun=t ;;
esac
printf "parsed OK\\n"
