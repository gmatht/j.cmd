// t51_swap: swap two variables through a temp
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int a = 1;
    int b = 2;
    int tmp;
    tmp = a;
    a = b;
    b = tmp;
    printf("%d %d\n", a, b);
    return 0;
}
