#include <stdio.h>
#include <stdlib.h>
int main(void) {
    int *a = malloc(3 * sizeof(int));
    a[0] = 10;
    a[1] = 20;
    a[2] = 30;
    int *p = a + 1;
    printf("%d %d\n", *p, p[1]);
    free(a);
    return 0;
}
