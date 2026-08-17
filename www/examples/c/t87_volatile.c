// t87_volatile: C type qualifier `volatile` on an int declaration (the
// grammars-v4 typeQualifier rule, volatile_). The v1 frontend parses
// the declaration but DROPS the initializer (the typeQualifier lowering
// gap, PARSER_GAPS.md — the same family as t82's `const int x = 5;`
// emitting NO assign), so only a 0-valued init prints a matching
// stdout; a non-zero init would mis-lower to an unset var (0) — the
// documented gap.
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    volatile int x = 0;
    printf("%d\n", x);
    return 0;
}
