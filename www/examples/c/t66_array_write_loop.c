// t66_array_write_loop: DYNAMIC array writes `a[i] = v` in a loop (v2;
// v1 required a compile-time constant index — the runtime arrayStore
// call receives the core-lowered index, never a stale store read)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int a[3];
    int i;
    for (i = 0; i < 3; i++) {
        a[i] = (i + 1) * 10;
    }
    for (i = 0; i < 3; i++) {
        int v = a[i];
        printf("%d\n", v);
    }
    int sum = 0;
    for (i = 0; i < 3; i++) {
        int v = a[i];
        sum = sum + v;
    }
    printf("sum=%d\n", sum);
    return 0;
}
