# t31_case_switch: case/switch dispatch
# diagnostics: program prints its result to stdout
X=2
case "$X" in
    1) echo one ;;
    2) echo two ;;
    *) echo other ;;
esac
