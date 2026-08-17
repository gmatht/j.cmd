// t49_prime: primality test — compute-then-test remainder (the test
// grammar is comparison-only, so `n % d == 0` is split into a temp).
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int n = 29;
    int d;
    int r;
    int prime = 1;
    for (d = 2; d < n; d++) {
        r = n % d;
        if (r == 0) {
            prime = 0;
            break;
        }
    }
    printf("%d\n", prime);
    return 0;
}
