// t79_switch_midbreak: a GUARDED mid-arm break — `case 1: if (c) break;
// rest;` exits the whole switch (the remainder of the merged arm wraps
// in the guard's else), while a false guard falls through
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int x = 1;
    switch (x) {
    case 1:
        printf("a\n");
        if (x == 1) { break; }
        printf("never\n");
    case 2:
        printf("b\n");
        break;
    default:
        printf("d\n");
    }
    printf("after\n");
    int y = 1;
    switch (y) {
    case 1:
        printf("p\n");
        if (y == 0) { break; }
        printf("q\n");
    case 2:
        printf("r\n");
        break;
    }
    return 0;
}
