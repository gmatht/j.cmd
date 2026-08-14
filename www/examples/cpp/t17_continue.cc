// t17_continue: A1 Continue node — skip an iteration of a for loop
// diagnostics: prints every iteration except the skipped one, then the
// final counter (the for-update still runs on continue)
#include <cstdio>
int main() {
    int i;
    for (i = 0; i < 5; i++) {
        if (i == 2) continue;
        printf("%d\n", i);
    }
    printf("done i=%d\n", i);
    return 0;
}
