#include <stdio.h>
#include <string.h>
int main(void) {
    char buf[32];
    char dst[32];
    sprintf(buf, "n=%d", 7);
    strcpy(dst, buf);
    printf("%s\n", dst);
    return 0;
}
