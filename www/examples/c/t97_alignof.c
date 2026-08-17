// t97_alignof: C11 alignment operator `_Alignof(T)` (the tree-sitter-c
// alignof_expression node; the grammars-v4 ALIGNOF unaryExpression).
// A compile-time-only operator with NO runtime effect: `_Alignof(T)`
// yields the alignment requirement of T (a constant expression, like
// sizeof), so evaluating it as an expression statement has no
// observable behavior. The v1 frontend parses it as a call-form
// statement and skips it (the same no-runtime-effect handling as t84
// `_Static_assert` / t85-t88 attributes / t89-t92 asm / t95 `_Alignas`
// — the faithful lowering of a compile-time-only construct is no
// emitted code at all). VALUE positions (`int x = _Alignof(int);`,
// printf args, conditions) REFUSE by design via the generic
// unsupported-function-call refusal — PARSER_GAPS.md: the C11
// alignment/type surface is a by-design refusal outside the v1 subset;
// the bare expression-statement position is the one expressible spot,
// riding the same call-form skip as the `_Static_assert` declaration.
// The gate's native side (gcc) validates the operator itself: if the
// C11 `_Alignof` spelling stopped being accepted, the native compile
// would fail and the gate would DIFF. (The `alignof` spelling is C23
// and the GNU `__alignof__` is an extension; `_Alignof` is the C11
// spelling, used directly so the coverage parse sees the node.)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    _Alignof(int);
    printf("ok\n");
    return 0;
}
