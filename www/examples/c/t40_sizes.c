// t40_sizes: sizeof of builtin types and of a struct variable
// diagnostics: program prints its result to stdout
#include <stdio.h>

struct Point {
    int x;
    int y;
};

int main(void) {
    struct Point p;
    p.x = 1;
    printf("%d %d %d\n", sizeof(char), sizeof(int), sizeof(double));
    printf("%d\n", sizeof(p));
    return 0;
}
