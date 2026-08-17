#include <stdio.h>
int main(void) {
    long long ll = 5000000001LL;
    unsigned int u = 3000000000u;
    int i = 7;
    if (ll > 3) { printf("ll-big\n"); }
    if (u > 2000000000u) { printf("u-big\n"); }
    if (u / 3 > 100) { printf("u-div\n"); }
    if (i < 10) { printf("i-small\n"); }
    if (ll % 2 == 0) { printf("even\n"); } else { printf("odd\n"); }
    if (ll + 1 > 5000000000LL) { printf("grew\n"); }
    if (!ll) { printf("falsy\n"); }
    return 0;
}
