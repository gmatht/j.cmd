// t59_multi_decl: multi-declarator declarations `int a, b;` and
// `int c = 3, d = 4;` (v2 — the v1 parser accepted one name only)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int a, b;
    int c = 3, d = 4;
    a = 1;
    b = 2;
    printf("%d %d %d %d\n", a, b, c, d);
    return 0;
}
