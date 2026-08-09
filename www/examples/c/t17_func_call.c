// t17_func_call: C user function call
// diagnostics: program prints its result to stdout
#include <stdio.h>

static int triple(int n) {
    return n * 3;
}

int main(void) {
    printf("%d\n", triple(5));
    return 0;
}

// DRIVER: frontend emit gap (red gate — the worker's work item).
