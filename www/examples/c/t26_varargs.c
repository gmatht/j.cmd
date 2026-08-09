#include <stdio.h>
#include <stdarg.h>
static int sum(int n, ...) {
    va_list ap;
    int s = 0;
    va_start(ap, n);
    while (n--) s += va_arg(ap, int);
    va_end(ap);
    return s;
}
int main(void) {
    printf("%d\n", sum(3, 1, 2, 3));
    return 0;
}
