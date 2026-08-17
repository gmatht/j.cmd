// t73_arith_calls: runtime function calls and ternaries INSIDE
// arithmetic (the next rung — previously "lower it to a temp", now
// hoisted to temps automatically): printf args, declaration
// initializers, compound assignments
// diagnostics: program prints its result to stdout
#include <stdio.h>

static int twice(int n) { return n * 2; }
static int add(int a, int b) { return a + b; }

int main(void) {
    int x = 5;
    printf("%d\n", twice(x) + 1);
    int y = add(x, 2) * 3;
    printf("%d\n", y);
    printf("%d\n", (x > 3 ? 10 : 20) + 1);
    int z = (x < 3 ? 1 : 2) + twice(x);
    printf("%d\n", z);
    x += twice(x);
    printf("%d\n", x);
    return 0;
}
