#include <stdio.h>
int main(void) {
    int i;
    for (i = 0; i < 5; i++) {
        if (i == 1) continue;
        if (i == 4) break;
        printf("%d\n", i);
    }
    return 0;
}
