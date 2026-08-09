#include <stdio.h>
int main(void) {
    int x = 5;
    int *p = &x;
    printf("%d\n", *p);
    *p = 7;
    int *q = p;
    *q = 9;
    printf("%d\n", x);
    return 0;
}
