// t85_attribute_specifier: C2x attribute specifier sequence —
// `[[maybe_unused]]` on an enumerator (the grammars-v4
// attributeSpecifierSequence rule: the C23 `[[...]]` attribute syntax in
// its enumerator position). A compile-time-only directive with NO runtime
// effect: the attribute is a compiler hint that never changes stdout.
// The v1 frontend parses the enum declaration and skips it (the t80 enum
// gap — enumerator values are not folded), so the attribute rides the
// same skip: the faithful lowering of a compile-time-only directive is no
// emitted code at all. Only the first enumerator (A = 0) prints a
// matching stdout; B would mis-lower to an unset var (the documented enum
// gap). The gate's native side (gcc) validates the attribute itself: if
// the C23 spelling stopped being accepted, the native compile would fail
// and the gate would DIFF. (The specifier/declarator positions —
// `[[maybe_unused]] int x;` / `int x [[maybe_unused]];` / the GNU
// `__attribute__` forms — REFUSE by design, PARSER_GAPS.md: attributes
// are a by-design refusal outside the v1 subset.)
// diagnostics: program prints its result to stdout
#include <stdio.h>

enum E { A [[maybe_unused]], B };

int main(void) {
    printf("%d\n", A);
    return 0;
}
