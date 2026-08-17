// t61_prefix_inc: prefix ++i / --i in statements and for headers (v2)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int i = 0;
    ++i;
    printf("%d\n", i);
    --i;
    printf("%d\n", i);
    int sum = 0;
    for (i = 0; i < 4; ++i) {
        sum = sum + i;
    }
    printf("%d\n", sum);
    return 0;
}
