// t43_percent: printf %% literal percent (format escapes pass through)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    printf("100%% done\n");
    printf("%d%%\n", 50);
    return 0;
}
