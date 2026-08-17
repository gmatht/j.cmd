#include <stdio.h>
int main(void) {
    long long ll = 9223372036854775807LL;  // 2^63-1, past 2^53
    if (ll % 2 == 0) { printf("even\n"); } else { printf("odd\n"); }
    if ((ll & 1) == 1) { printf("lsb-set\n"); }
    if (ll >> 62 == 1) { printf("top-bits\n"); }
    return 0;
}
