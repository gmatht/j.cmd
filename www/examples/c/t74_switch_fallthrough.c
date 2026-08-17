// t74_switch_fallthrough: C switch fallthrough — the shared-body form
// (`case 1: case 2:`), end-of-body fallthrough (case 3 runs into case 4)
// and fallthrough into default
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int x = 1;
    switch (x) {
    case 1:
    case 2:
        printf("low\n");
        break;
    case 3:
        printf("three\n");
    case 4:
        printf("three-or-four\n");
        break;
    default:
        printf("other\n");
    }
    int y = 3;
    switch (y) {
    case 1:
        printf("y1\n");
        break;
    case 3:
        printf("y3\n");
    default:
        printf("y-done\n");
    }
    return 0;
}
