#include <stdio.h>
int main(void) {
    int i, j;
    for (i = 0; i < 3; i++) {
        for (j = 0; j < 3; j++) {
            if (i == 1 && j == 1) goto out;
            printf("%d%d\n", i, j);
        }
    }
out:
    printf("done\n");
    return 0;
}
