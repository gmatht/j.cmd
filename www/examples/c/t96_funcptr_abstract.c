// t96_funcptr_abstract: an ABSTRACT POINTER DECLARATOR (`int *` with no
// identifier) in a function-pointer declaration's parameter list —
// `int (*f)(int *) = twice;`. The parser consumes the parameter list
// without checking pointer types (the v1 subset's function-pointer
// declarations), so the construct emits; the call `f(5)` folds through
// the funcPtrs target like t29.
// diagnostics: program prints its result to stdout
#include <stdio.h>

static int twice(int x) { return x * 2; }

int main(void) {
    int (*f)(int *) = twice;
    printf("%d\n", f(5));
    return 0;
}
