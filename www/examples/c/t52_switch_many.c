// t52_switch_many: switch with several cases and a default
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int g = 3;
    switch (g) {
    case 1:
        printf("one\n");
        break;
    case 2:
        printf("two\n");
        break;
    case 3:
        printf("three\n");
        break;
    case 4:
        printf("four\n");
        break;
    default:
        printf("other\n");
    }
    return 0;
}
