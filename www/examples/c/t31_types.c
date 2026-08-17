#include <stdio.h>
int main(void) {
    int i = 7;
    long long ll = 5000000000LL;
    unsigned int u = 3000000000u;
    unsigned long long ul = 9223372036854775807ULL;
    printf("i=%d sizeof-int=%d sizeof-ll=%d\n", i, sizeof(int), sizeof(long long));
    printf("ll=%lld ll+1=%lld\n", ll, ll + 1);
    printf("u=%u u/2=%u\n", u, u / 2);
    printf("ul=%llu\n", ul);
    printf("cast=%d\n", (int)ll);
    return 0;
}
