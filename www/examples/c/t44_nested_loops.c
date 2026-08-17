// t44_nested_loops: nested for loops (multiplication table rows)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int i;
    int j;
    for (i = 1; i <= 3; i++) {
        for (j = 1; j <= 3; j++) {
            printf("%d%d\n", i, j);
        }
    }
    return 0;
}
