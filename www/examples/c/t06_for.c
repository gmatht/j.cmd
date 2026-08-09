#include <stdio.h>
int main(void) {
    int i;
    for (i = 0; i < 3; i += 1) {
        printf("f%d\n", i);
    }
    return 0;
}
