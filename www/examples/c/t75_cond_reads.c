// t75_cond_reads: runtime VALUE reads in CONDITIONS — deref/index/call
// operands are hoisted to temps (an if hoists once; a while/for loop
// refreshes them at the top of every iteration via a guard structure).
// diagnostics: program prints its result to stdout
#include <stdio.h>
#include <stdlib.h>

static int twice(int n) { return n * 2; }

int main(void) {
    int a[4] = {1, 5, 3, 9};
    int i = 0;
    int max = 0;
    for (i = 0; i < 4; i++) {
        if (a[i] > max) { max = a[i]; }
    }
    printf("max=%d\n", max);
    int *p = malloc(4 * sizeof(int));
    p[0] = 0; p[1] = 1; p[2] = 2; p[3] = 3;
    int *q = p + 1;
    int sum = 0;
    while (*q < 3) {
        sum = sum + *q;
        q++;
    }
    printf("sum=%d\n", sum);
    if (twice(3) > 5) { printf("call-cond\n"); }
    free(p);
    return 0;
}
