// t34_elseif: if / else-if / else chain
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int s = 85;
    if (s >= 90) {
        printf("A\n");
    } else if (s >= 80) {
        printf("B\n");
    } else if (s >= 70) {
        printf("C\n");
    } else {
        printf("F\n");
    }
    return 0;
}
