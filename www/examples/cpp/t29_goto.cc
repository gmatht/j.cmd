// t29_goto: tree-sitter `statement_identifier` — the label node in
// labeled_statement / goto_statement (C++ keeps C's goto; clib lowers
// it to A1 Label/Goto, and the core RestructureGoto pass rewrites the
// jump into structured flow)
// diagnostics: prints 1 2 3 (the backward guarded goto is a post-test
// loop), then the value after the loop
#include <cstdio>
int main() {
    int i = 0;
loop:
    i++;
    printf("%d\n", i);
    if (i < 3) goto loop;
    printf("done i=%d\n", i);
    return 0;
}
