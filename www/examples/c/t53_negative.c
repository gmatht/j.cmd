// t53_negative: signed integer arithmetic (unary minus, negative results)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int x = -3;
    int y = 10;
    printf("%d\n", x + y);
    printf("%d\n", x * 2);
    printf("%d\n", y - 15);
    printf("%d\n", -x);
    return 0;
}
