# alphanumeric_compare.sh — a bash COMPARATOR for sorting words.
#
# THE PROTOCOL (C qsort convention): the function is called with two
# words as $1 and $2, and must ECHO a signed number to stdout:
#   -1  $1 sorts before $2
#    0  equal
#    1  $1 sorts after $2
# Nothing else — the caller captures the echo, it must not reach the
# terminal (that is why the verdicts go to stdout via echo, and the
# caller runs the function under command substitution / capture).
#
# WHO USES IT:
#   * the `qsort` builtin:
#       a=(pear apple fig banana)
#       qsort a alphanumeric_compare; echo "${a[@]}"   → apple banana fig pear
#   * C code sourced through the c-sh-go frontend — my_qsort.c calls
#     the comparator by name via its cmp_call bridge:
#       source /examples/sh-posix/alphanumeric_compare.sh
#       source /examples/c/my_qsort.c                  → apple banana fig pear
#
# [[ $1 < $2 ]] is the LEXICOGRAPHIC (alphabetical) comparison — the
# same ordering C's strcmp uses for ASCII text. Swap the two verdicts
# (or flip the operators) to sort descending instead:
#   reverse_compare() { if [[ "$1" > "$2" ]]; then echo -1;
#                       elif [[ "$1" < "$2" ]]; then echo 1;
#                       else echo 0; fi }
alphanumeric_compare() { if [[ "$1" < "$2" ]]; then echo -1;
                         elif [[ "$1" > "$2" ]]; then echo 1;
                         else echo 0; fi }
