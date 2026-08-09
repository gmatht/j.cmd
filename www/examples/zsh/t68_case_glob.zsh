# t68_case_glob: case dispatch with glob patterns
# diagnostics: program prints its result to stdout
case "hello" in
  h*) echo "star" ;;
  *l* | *x*) echo "alt" ;;
esac
case "axl" in
  h*) echo "star2" ;;
  *l* | *x*) echo "alt2" ;;
esac
