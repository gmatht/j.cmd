// t13_strlen: C strlen
// diagnostics: program prints its result to stdout
// DRIVER: frontend emit gap (strlen from <string.h>).
#include <stdio.h>
#include <string.h>

int main(void) {
    printf("%d\n", (int)strlen("hello"));
    return 0;
}
