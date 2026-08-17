// t37_for_countdown: for loop with i-- countdown
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int i;
    for (i = 5; i > 0; i--) {
        printf("%d\n", i);
    }
    return 0;
}
