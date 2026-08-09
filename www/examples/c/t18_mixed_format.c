// t18_mixed_format: C printf with mixed %d %s
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    printf("%d-%s\n", 7, "hi");
    return 0;
}
