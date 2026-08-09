// t15_for_arith: C arithmetic for loop
// diagnostics: program prints its result to stdout
// DRIVER: frontend emit gap (c-style for with int declarations).
#include <stdio.h>

int main(void) {
    int sum = 0;
    for (int i = 1; i <= 5; i++) {
        sum = sum + i;
    }
    printf("%d\n", sum);
    return 0;
}
