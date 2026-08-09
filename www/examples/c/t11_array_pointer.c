#include <stdio.h>
int main(void) {
    int a[3] = {10, 20, 30};
    int *p = &a[1];
    printf("%d\n", *p);
    printf("%d\n", p[1]);
    printf("%d\n", p[-1]);
    *p = 99;
    printf("%d\n", a[1]);
    return 0;
}
