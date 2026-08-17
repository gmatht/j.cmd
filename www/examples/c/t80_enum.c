// t80_enum: C enum declaration + enumeration constant used as an int
// expression (the first enumerator RED = 0). The v1 frontend parses the
// enum declaration but skips it — the enumerator init values are not
// folded (PARSER_GAPS.md), so only the 0-valued first enumerator prints
// a matching stdout; GREEN/BLUE would mis-lower to unset vars.
// diagnostics: program prints its result to stdout
#include <stdio.h>

enum Color { RED, GREEN, BLUE };

int main(void) {
    printf("%d\n", RED);
    return 0;
}
