// t33_logic: logical && || ! in conditions, plus C numeric truth
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int a = 3;
    int b = 0;
    if (a > 1 && b == 0) { printf("and\n"); }
    if (a < 1 || b == 0) { printf("or\n"); }
    if (a > 1 || b > 1) { printf("or2\n"); }
    if (!(a == 1)) { printf("not\n"); }
    if (a) { printf("truthy\n"); }
    return 0;
}
