# t76_case_alt: case with | alternatives and quoted patterns
# diagnostics: program prints its result to stdout
x=start
case $x in
    start|stop) echo control ;;
    *) echo other ;;
esac
