// t77_multichar: multi-char literals — C packs the bytes big-endian
// into an int (implementation-defined; GCC 'ab' = 0x6162 = 24930)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    printf("%d\n", 'ab');
    printf("%d\n", 'abc');
    return 0;
}
