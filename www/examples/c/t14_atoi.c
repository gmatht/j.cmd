// t14_atoi: C atoi + arithmetic
// diagnostics: program prints its result to stdout
// DRIVER: frontend emit gap (atoi from <stdlib.h>).
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int n = atoi("42");
    printf("%d\n", n + 1);
    return 0;
}
