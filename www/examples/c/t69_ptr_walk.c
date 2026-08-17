// t69_ptr_walk: the pointer-walk idiom — mem-slice-2 dynamic pointer
// arithmetic (core request c-mem-slice2): `p < a + 4` compare, `p = p + 1`
// advance, `*p` reads through the advancing pointer. The pointer's
// position lives in a runtime handle (the while-header cond is emitted
// BEFORE the body's advance, so a compile-time offset could never
// advance per-iteration).
// diagnostics: program prints its result to stdout
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int *a = malloc(4 * sizeof(int));
    int i;
    for (i = 0; i < 4; i++) { a[i] = i * 10; }
    int *p = a;
    int sum = 0;
    while (p < a + 4) {
        int v = *p;
        sum = sum + v;
        p = p + 1;
    }
    printf("%d\n", sum);
    free(a);
    return 0;
}
