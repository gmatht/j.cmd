#include <stdio.h>
#include <stdlib.h>
int main(void) {
    long long *a = malloc(2 * sizeof(long long));
    a[0] = 5000000000LL;
    a[1] = 6000000000LL;
    long long *p = a + 1;
    unsigned long long *b = malloc(2 * sizeof(unsigned long long));
    b[0] = 9223372036854775807ULL;
    b[1] = 9223372036854775807ULL - 1;
    unsigned int *c = malloc(2 * sizeof(unsigned int));
    c[0] = 4000000000u;
    c[1] = 1u;
    printf("%lld %lld\n", a[0], *p);
    printf("%llu %llu\n", b[0], b[1]);
    printf("%u %u\n", c[0], c[1]);
    return 0;
}
