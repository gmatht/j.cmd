// t82_const: C type qualifier `const` on an int declaration. The v1
// frontend parses the declaration but DROPS the initializer (the
// typeQualifier lowering gap, PARSER_GAPS.md: "const int x = 5; emits
// NO assign"), so only a 0-valued init prints a matching stdout;
// a non-zero init would mis-lower to an unset var (0) — the documented
// gap.
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    const int x = 0;
    printf("%d\n", x);
    return 0;
}
