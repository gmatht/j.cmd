// t93_dowhile_compound: the A1 DoWhile node — a C do-while with a
// compound condition and body arithmetic/printf, emitted as the
// post-test DoWhile (body first, THEN the cond — the pre-test While
// duplication of the earlier rung is gone; the core's ESTree renderer
// handles the A1 DoWhile node natively). The cond is a plain test
// string (no runtime reads) and the body has no break/continue, so the
// native do-while lowering applies.
// diagnostics: program prints its result to stdout
#include <stdio.h>
int main(void) {
    int i = 0;
    int sum = 0;
    do {
        sum = sum + i;
        i++;
        printf("iter %d\n", i);
    } while (i < 4 && sum < 10);
    printf("sum=%d i=%d\n", sum, i);
    return 0;
}
