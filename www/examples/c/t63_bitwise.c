// t63_bitwise: bitwise operators as values — & | ^ ~ << >> (v2; the
// 32-bit int domain matches C's `int`)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int a = 12;
    int b = 10;
    printf("%d\n", a & b);
    printf("%d\n", a | b);
    printf("%d\n", a ^ b);
    printf("%d\n", ~a);
    printf("%d\n", 1 << 5);
    printf("%d\n", 256 >> 3);
    printf("%d\n", ~0);
    return 0;
}
