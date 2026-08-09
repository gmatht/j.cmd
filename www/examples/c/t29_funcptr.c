#include <stdio.h>
static int twice(int x) { return x * 2; }
int main(void) {
    int (*f)(int) = twice;
    printf("%d\n", f(5));
    return 0;
}
