// t71_multi_out: multi-out-param function — `void getdim(int *w, int *h)`
// with TWO write-target params (multi-return A1, core request
// c-multi-return). The out-param transform (harness/outparam_to_returns.py)
// echoes one value per line; the caller captures and destructures.
// diagnostics: program prints its result to stdout
#include <stdio.h>

static void getdim(int *w, int *h) {
    *w = 3;
    *h = 5;
}

int main(void) {
    int w, h;
    getdim(&w, &h);
    printf("%d %d\n", w, h);
    return 0;
}
