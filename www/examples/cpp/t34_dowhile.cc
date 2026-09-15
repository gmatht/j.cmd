// t34_dowhile: the A1 DoWhile node — a C++ do-while loop with a plain
// test-string cond and a body with no break/continue, emitted as the
// post-test DoWhile (body first, THEN the cond — the faithful shape;
// the core's ESTree renderer handles the A1 DoWhile node natively).
// diagnostics: prints each iteration, then the final values
#include <cstdio>
int main() {
    int i = 0;
    int sum = 0;
    do {
        sum += i;
        i++;
        printf("iter %d\n", i);
    } while (i < 4);
    printf("sum=%d i=%d\n", sum, i);
    return 0;
}
