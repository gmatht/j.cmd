// t72_multi_out_mix: out-params mixed with inputs — a multi-write
// function with a read-only non-pointer param (renumbered when the
// write-params drop) and a read-only pointer param (`*dst = *src`)
// diagnostics: program prints its result to stdout
#include <stdio.h>

static void getdim(int *w, int *h, int scale) {
    *w = 3 * scale;
    *h = 5 * scale;
}

static void copy(int *dst, int *src) {
    *dst = *src;
}

int main(void) {
    int w, h, s = 2;
    getdim(&w, &h, s);
    printf("%d %d\n", w, h);
    int a = 9, b;
    copy(&b, &a);
    printf("%d\n", b);
    return 0;
}
