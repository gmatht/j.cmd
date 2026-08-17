// t88_gnu_attribute: GNU `__attribute__((...))` on an enumerator — the
// grammars-v4 gnuAttribute/gnuAttributeList/gnuAttributes/
// gnuSingleAttribute rules (the GNU extension spelling; t85/t86 cover
// the C23 `[[...]]` attributeSpecifierSequence forms). A compile-time-
// only directive with NO runtime effect: the attribute is a compiler
// hint that never changes stdout. The v1 frontend parses the enum
// declaration and skips it (the t80 enum gap — enumerator values are
// not folded), so the attribute rides the same skip: the faithful
// lowering of a compile-time-only directive is no emitted code at all.
// Only the first enumerator (A = 0) prints a matching stdout; B would
// mis-lower to an unset var (the documented enum gap). The gate's
// native side (gcc) validates the attribute itself: if the GNU
// `__attribute__` spelling stopped being accepted, the native compile
// would fail and the gate would DIFF. (The specifier/declarator
// positions — `__attribute__((unused)) int x;` / `int x
// __attribute__((unused));` / `__attribute__((noreturn)) void f();` —
// REFUSE by design, PARSER_GAPS.md: GNU attributes are a by-design
// refusal outside the v1 subset; the enumerator position is the one
// expressible spot, riding the enum skip like the C23 forms in
// t85/t86.)
// diagnostics: program prints its result to stdout
#include <stdio.h>

enum E { A __attribute__((unused)), B };

int main(void) {
    printf("%d\n", A);
    return 0;
}
