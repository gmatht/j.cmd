// t38_for_ever: infinite for(;;) loop exited by break
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int i = 0;
    for (;;) {
        i += 1;
        if (i == 3) { break; }
        printf("e%d\n", i);
    }
    return 0;
}
