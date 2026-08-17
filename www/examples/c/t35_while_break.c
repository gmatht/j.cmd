// t35_while_break: while loop with break and continue
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int i = 0;
    while (1) {
        i += 1;
        if (i == 2) { continue; }
        if (i >= 5) { break; }
        printf("%d\n", i);
    }
    return 0;
}
