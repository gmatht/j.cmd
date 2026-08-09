#include <stdio.h>
int main(void) {
    int err = 0;
    if (err) goto cleanup;
    printf("work\n");
cleanup:
    printf("cleanup\n");
    return 0;
}
