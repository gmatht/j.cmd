#include <stdio.h>
int main(void) {
    int x = 5;
    int *p = &x;
    printf("a=%d\n", *p);
    *p = 7;
    printf("b=%d\n", x);
    return 0;
}
