// t32_divmod: integer division and modulo (C truncation toward zero)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    printf("%d\n", 17 / 5);
    printf("%d\n", 17 % 5);
    printf("%d\n", -7 / 2);
    printf("%d\n", -7 % 2);
    printf("%d\n", 100 / 10);
    printf("%d\n", 9 % 3);
    return 0;
}
