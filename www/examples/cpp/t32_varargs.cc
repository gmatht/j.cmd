// t32_varargs — variadic function signature (`...` in the parameter
// list, tree-sitter-cpp's variadic_declarator rule). The shared clib
// lowering folds variadic user-function calls with literal args (the
// v1 varargs idiom); the C++ subset expresses the signature exactly
// like c-sh-go's t26_varargs.c, minus the va_arg macro (tree-sitter
// cannot parse `va_arg(ap, int)` — a type as an argument expression).
#include <stdio.h>
static int sum(int n, ...) { return n * 2; }
int main(void) {
    printf("%d\n", sum(3, 1, 2, 3));
    return 0;
}
