// t14_break: A1 Break node — break out of a while loop
// diagnostics: prints each iteration, then the value after the break
#include <cstdio>
int main() {
    int i = 0;
    while (1) {
        i++;
        if (i == 3) break;
        printf("%d\n", i);
    }
    printf("done i=%d\n", i);
    return 0;
}
