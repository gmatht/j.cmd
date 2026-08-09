// t16_strcmp: C strcmp
// diagnostics: program prints its result to stdout
#include <stdio.h>
#include <string.h>

int main(void) {
    printf("%d\n", strcmp("a", "b") < 0);
    printf("%d\n", strcmp("same", "same") == 0);
    return 0;
}

// DRIVER: frontend emit gap (red gate — the worker's work item).
