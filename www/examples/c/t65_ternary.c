// t65_ternary: the ternary operator cond ? a : b (v2) — as a printf
// arg, as an assignment RHS, and with an arithmetic branch
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int x = 5;
    printf("%d\n", x > 3 ? 1 : 0);
    printf("%d\n", x < 3 ? 1 : 0);
    int m = x > 3 ? 10 : 20;
    printf("%d\n", m);
    printf("%d\n", x ? 7 : 8);
    int y = 0;
    int z = y ? 100 : x * 2;
    printf("%d\n", z);
    return 0;
}
