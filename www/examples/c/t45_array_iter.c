// t45_array_iter: iterate an array with a DYNAMIC index (a[i] in a loop)
// — the read is lowered to a temp first (the A1 Arith grammar has no
// Call node, so a runtime array read cannot appear inside arithmetic).
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int a[3] = {10, 20, 30};
    int i;
    int v;
    int sum = 0;
    for (i = 0; i < 3; i++) {
        v = a[i];
        printf("%d\n", v);
        sum = sum + v;
    }
    printf("sum=%d\n", sum);
    return 0;
}
