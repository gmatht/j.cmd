// t94_incdec: statement-position ++ / -- emit the A1 arith IncDec node
// (prefix/postfix x delta: ++i, --i, i++, i--)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int x = 5;
    ++x;
    printf("%d\n", x);
    --x;
    printf("%d\n", x);
    x++;
    printf("%d\n", x);
    x--;
    printf("%d\n", x);
    return 0;
}
