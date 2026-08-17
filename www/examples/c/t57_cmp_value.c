// t57_cmp_value: a comparison used as a VALUE (printf %d of an == result)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int a = 5;
    printf("%d\n", a == 5);
    printf("%d\n", a > 3);
    return 0;
}
