// t33_variadic_param — typed variadic parameter (`int ...` in the
// parameter list: tree-sitter-cpp's variadic_parameter_declaration /
// variadic_declarator rules — the GNU-extension form of the plain `...`
// t32 covers; g++ accepts it). The redundant type specifier is dropped
// at the token level (main.go translate) so clib sees the same `...`
// marker and the shared lowering folds the literal-arg call exactly
// like t32_varargs.cc.
#include <stdio.h>
static int sum(int n, int ...) { return n * 2; }
int main(void) {
    printf("%d\n", sum(3, 1, 2, 3));
    return 0;
}
