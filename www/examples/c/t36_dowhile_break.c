// t36_dowhile_break: do-while with break
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int i = 0;
    do {
        i += 1;
        if (i == 3) { break; }
        printf("d%d\n", i);
    } while (i < 5);
    printf("end\n");
    return 0;
}
