#include <stdio.h>
#include <stdlib.h>
int main(void) {
    long long *a = malloc(2 * sizeof(long long));
    a[0] = 9223372036854775807LL;
    long long x = a[0] + 1;
    long long y = 0;
    y += a[0];
    if (a[0] > 3) { printf("big\n"); }
    printf("%lld %lld %lld\n", x, y, a[0] + 2);
    return 0;
}
