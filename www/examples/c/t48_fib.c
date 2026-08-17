// t48_fib: Fibonacci via two running variables
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int a = 0;
    int b = 1;
    int c;
    int i;
    for (i = 0; i < 8; i++) {
        printf("%d\n", a);
        c = a + b;
        a = b;
        b = c;
    }
    return 0;
}
