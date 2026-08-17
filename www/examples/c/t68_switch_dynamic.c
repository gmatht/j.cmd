// t68_switch_dynamic: switch on a runtime-computed discriminant with an
// arithmetic case body (v2 — combines the new expression forms)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int x = 7;
    int g = x & 3;
    switch (g) {
    case 0:
        printf("zero\n");
        break;
    case 1:
        printf("one\n");
        break;
    case 2:
        printf("two\n");
        break;
    default:
        printf("three\n");
    }
    printf("%d\n", x > 4 ? 1 : 0);
    return 0;
}
