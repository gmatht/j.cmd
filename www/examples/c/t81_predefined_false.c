// t81_predefined_false: C23 predefined constant `false` (0) in an int
// expression. The v1 frontend lexes `false` as a plain identifier, so it
// lowers to getVar("false") — an unset var, which the %d fold renders as
// 0, matching gcc's <stdbool.h> false. `true` (1) would mis-lower to
// unset (0) — the documented predefinedConstant lowering gap
// (PARSER_GAPS.md); only the 0-valued form prints a matching stdout.
// diagnostics: program prints its result to stdout
#include <stdio.h>
#include <stdbool.h>

int main(void) {
    printf("%d\n", false);
    return 0;
}
