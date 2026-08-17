// t78_readwrite_out: a READ+WRITE out-param — `void bump(int *x) {
// *x = *x + 1; }` (the read+write case the out-param transform handles
// as pass-by-value + return: the caller passes the current value, the
// function echoes the new one)
// diagnostics: program prints its result to stdout
#include <stdio.h>

static void bump(int *x) {
    *x = *x + 1;
}

static void addout(int *x, int n) {
    *x = *x + n;
}

int main(void) {
    int v = 3;
    bump(&v);
    printf("%d\n", v);
    addout(&v, 5);
    printf("%d\n", v);
    return 0;
}
