// t70_ptr_walk_store: the write-walk idiom — `*p = v` through an
// advancing pointer, bounded by `p != end` (mem-slice-2; `end = a + 3`
// is a static offset, p advances via p++)
// diagnostics: program prints its result to stdout
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int *a = malloc(3 * sizeof(int));
    int i;
    for (i = 0; i < 3; i++) { a[i] = 0; }
    int *p = a;
    int *end = a + 3;
    while (p != end) {
        *p = 42;
        p++;
    }
    printf("%d %d %d\n", a[0], a[1], a[2]);
    free(a);
    return 0;
}
