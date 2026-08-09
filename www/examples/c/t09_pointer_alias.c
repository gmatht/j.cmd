#include <stdio.h>
int main(void) {
    int a = 1;
    int b = 2;
    int *p = &a;
    int *q = p;
    *q = 9;
    printf("a=%d b=%d\n", a, b);
    return 0;
}
