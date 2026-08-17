// t50_minmax: min/max of two values with if/else
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int a = 12;
    int b = 7;
    int lo;
    int hi;
    if (a < b) {
        lo = a;
        hi = b;
    } else {
        lo = b;
        hi = a;
    }
    printf("%d %d\n", lo, hi);
    return 0;
}
