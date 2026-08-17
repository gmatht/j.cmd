// t54_clamp_abs: value clamping and absolute value (adjust-then-test)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int lo = 0;
    int hi = 10;
    int x = -5;
    if (x < lo) { x = lo; }
    if (x > hi) { x = hi; }
    printf("%d\n", x);
    int y = 15;
    if (y < lo) { y = lo; }
    if (y > hi) { y = hi; }
    printf("%d\n", y);
    int n = -42;
    if (n < 0) { n = -n; }
    printf("%d\n", n);
    return 0;
}
