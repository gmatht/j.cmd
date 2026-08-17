// t46_factorial: running-product loop (while + compound reads)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int n = 5;
    int f = 1;
    while (n > 1) {
        f = f * n;
        n = n - 1;
    }
    printf("%d\n", f);
    return 0;
}
