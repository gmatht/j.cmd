#include <stdio.h>
int main(void) {
    int a = 5;
    int b = 5;
    if (a == b) { printf("eq\n"); }
    if (a != 3) { printf("ne\n"); }
    if (a >= 5 && b <= 5) { printf("both\n"); }
    return 0;
}
