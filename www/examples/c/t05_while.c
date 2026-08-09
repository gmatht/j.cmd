#include <stdio.h>
int main(void) {
    int i = 0;
    while (i < 3) {
        printf("w%d\n", i);
        i += 1;
    }
    return 0;
}
