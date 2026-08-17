// t58_func_runtime: user functions called with RUNTIME args — the
// VALUE-returning dispatch (fnValue; the old fnCall path silently
// dropped the value — fixed). Covers multi-param, multi-statement
// bodies and nested calls.
// diagnostics: program prints its result to stdout
#include <stdio.h>

static int twice(int n) {
    return n * 2;
}

static int add(int a, int b) {
    return a + b;
}

static int step(int x) {
    int y = x + 1;
    return y * 2;
}

int main(void) {
    int x = 5;
    printf("%d\n", twice(x));
    printf("%d\n", add(x, 4));
    printf("%d\n", step(x));
    printf("%d\n", twice(add(x, 1)));
    return 0;
}
