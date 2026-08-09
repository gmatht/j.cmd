#include <stdio.h>
int main(void) {
    int x = 2;
    switch (x) {
    case 1:
        printf("one\n");
        break;
    case 2:
        printf("two\n");
        break;
    default:
        printf("other\n");
    }
    return 0;
}
