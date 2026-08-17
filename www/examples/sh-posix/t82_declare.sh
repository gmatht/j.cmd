# t82_declare: declare -i / readonly / typeset scalar declarations (A1 Declare construct)
# diagnostics: program prints its result to stdout
declare -i x=5
readonly r=3
typeset -i t=7
echo "$x $r $t"
