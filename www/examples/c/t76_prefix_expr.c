// t76_prefix_expr: prefix ++i / --i in EXPRESSION position — the value
// is the NEW value, hoisted to an increment statement + the plain read
// (printf args, declaration initializers, compound RHS)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int x = 2;
    printf("%d\n", ++x);
    printf("%d\n", ++x + 1);
    int y = ++x;
    printf("%d %d\n", x, y);
    int i = 0;
    while (++i < 3) {
        printf("w%d\n", i);
    }
    printf("done%d\n", i);
    return 0;
}
