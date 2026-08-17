// t41_gcd: Euclid's algorithm — while loop with % and a swap
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int a = 48;
    int b = 36;
    int r;
    while (b != 0) {
        r = a % b;
        a = b;
        b = r;
    }
    printf("%d\n", a);
    return 0;
}
