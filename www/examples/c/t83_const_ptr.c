// t83_const_ptr: C type qualifier on a POINTER declarator — `int * const
// p` — the grammars-v4 rule typeQualifierList (a qualifier list inside
// the `*` declarator; also covers `int * volatile p`). The v1 frontend
// parses the declaration but mis-lowers it: the qualifier is read as the
// variable name and the declarator's real name + initializer are dropped
// (the typeQualifierList lowering gap, PARSER_GAPS.md — the same family
// as t82's `const int x = 5;` emitting NO assign), so only the
// 0-valued target prints a matching stdout: *p reads an unset handle (0)
// instead of a, while gcc reads a (0 here); a non-zero target would
// mis-lower (native != transpiled) — the documented gap.
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int a = 0;
    int * const p = &a;
    printf("%d\n", *p);
    return 0;
}
