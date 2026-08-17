// t67_heap_dyn: DYNAMIC indices into a malloc'd heap array — `p[i]`
// with i a variable, both read and write (v2; v1 required a constant
// index — the mem arena offsets are runtime arith calls now)
// diagnostics: program prints its result to stdout
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int *a = malloc(3 * sizeof(int));
    int i;
    for (i = 0; i < 3; i++) {
        a[i] = (i + 1) * 7;
    }
    for (i = 0; i < 3; i++) {
        int v = a[i];
        printf("%d\n", v);
    }
    free(a);
    return 0;
}
