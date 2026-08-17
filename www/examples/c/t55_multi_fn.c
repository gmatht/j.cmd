// t55_multi_fn: several user functions, literal calls folded inside arith
// diagnostics: program prints its result to stdout
#include <stdio.h>

static int add(int a, int b) {
    return a + b;
}

static int mul(int a, int b) {
    return a * b;
}

int main(void) {
    printf("%d\n", add(2, 3) + mul(4, 5));
    printf("%d\n", mul(add(1, 2), 3));
    return 0;
}
