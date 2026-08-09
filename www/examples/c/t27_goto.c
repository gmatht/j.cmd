#include <stdio.h>
int main(void) {
    int i = 0;
loop:
    i++;
    if (i < 3) goto loop;
    printf("%d\n", i);
    return 0;
}
