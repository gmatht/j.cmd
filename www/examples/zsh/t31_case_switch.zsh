# t31_case_switch: case/switch dispatch
# diagnostics: program prints its result to stdout
x=2
case $x in
    1) echo one ;;
    2) echo two ;;
    *) echo other ;;
esac
