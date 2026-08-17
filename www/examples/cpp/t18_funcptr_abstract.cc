// t18_funcptr_abstract: an ABSTRACT POINTER DECLARATOR (`int *` with no
// identifier) in a function-pointer declaration's parameter list —
// `int (*f)(int *) = magic;`. The parser consumes the parameter list
// without checking pointer types (the shared clib lowering's
// function-pointer declarations), so the construct emits; the call
// `f(0)` folds through the funcPtrs target (all-literal args) like the
// C corpus t29/t96. Unlike C mode, g++ ENFORCES the C++ function-
// pointer type match, so the target's signature must be `int(int *)`
// and the call passes a foldable pointer-typed argument — `0`, the
// null pointer constant (the C t96's `f(5)` would be a compile error
// here, and `f(&x)` a clib refusal: non-literal args don't fold).
// diagnostics: program prints its result to stdout
#include <cstdio>

static int magic(int *p) { return 7; }

int main() {
    int (*f)(int *) = magic;
    printf("%d\n", f(0));
    return 0;
}
