// t64_bitwise_cond: arithmetic in CONDITIONS — bitwise and modulo tests
// (v2; the bash test-string grammar is comparison-only, so such
// conditions route to the runtime arith-eval truth — the even/odd,
// flag-mask and remainder idioms)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int x = 5;
    if (x & 1) { printf("odd\n"); } else { printf("even\n"); }
    int y = 10;
    if (y & 1) { printf("odd2\n"); } else { printf("even2\n"); }
    if ((x & 4) == 4) { printf("bit2\n"); }
    int mask = 3;
    if ((x & mask) == 1) { printf("low2\n"); }
    int n = 17;
    if (n % 2 == 0) { printf("n-even\n"); } else { printf("n-odd\n"); }
    return 0;
}
