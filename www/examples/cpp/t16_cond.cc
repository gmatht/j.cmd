// t16_cond: A1 Cond node — the conditional (ternary) expression ?:
// diagnostics: picks the larger of two ints, then the sign of a third
// (incl. a nested ternary for the zero case)
#include <cstdio>
int main() {
    int a = 3;
    int b = 5;
    int m = (a > b) ? a : b;
    printf("max=%d\n", m);
    int x = -2;
    int s = (x > 0) ? 1 : (x < 0) ? -1 : 0;
    printf("sign=%d\n", s);
    return 0;
}
