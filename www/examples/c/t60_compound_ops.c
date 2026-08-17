// t60_compound_ops: the full compound-assignment family
// *= /= %= <<= >>= &= |= ^= (v2 — v1 had only = += -=)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int x = 10;
    x *= 3;
    x /= 4;
    x %= 5;
    printf("%d\n", x);
    int f = 1;
    f <<= 3;
    f >>= 1;
    printf("%d\n", f);
    int m = 12;
    m &= 6;
    m |= 1;
    m ^= 5;
    printf("%d\n", m);
    return 0;
}
