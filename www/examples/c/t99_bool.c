// t99_bool: C23 / stdbool.h booleans — `bool` folds to int, true/false
// to 1/0 (the SAME demotion the CPP frontend's desugar applies; a raw
// Var("true") read would be an undefined-variable guess)
// diagnostics: prints 1 0 1
#include <stdio.h>
#include <stdbool.h>
int main(void) {
    bool ok = true;
    bool no = false;
    printf("%d %d %d\n", ok, no, ok || no);
    return 0;
}
