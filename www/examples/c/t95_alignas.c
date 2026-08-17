// t95_alignas: C11 alignment specifier `_Alignas(16)` on an int
// declaration (the tree-sitter-c alignas_qualifier node; grammars-v4
// alignmentSpecifier rule). A compile-time-only directive with NO
// runtime effect: the qualifier requests a minimum alignment for the
// declared object — an ABI/layout hint that never changes stdout. A
// declaration STARTING with `_Alignas` (`_Alignas(16) int x = 5;`)
// refuses (the statement parser reads it as a call statement and
// chokes on the trailing type — PARSER_GAPS.md: alignas is a by-design
// refusal outside the v1 subset). The expressible spot is the
// qualifier-PREFIXED form: `const _Alignas(16) int x = 5;` — `const`
// parses as an id and the WHOLE declaration rides the statement-
// position bare-id skip to the `;` (the same no-runtime-effect
// handling as t82/t87's qualifier declarations and t84 `_Static_assert`
// / t89 `asm volatile`), so the faithful lowering of a compile-time-
// only directive is no emitted code at all. The declared object is
// never read (a read would mis-lower to an unset var — the documented
// const/init-drop gap), so stdout comes from code the frontend fully
// expresses. The gate's native side (gcc) validates the qualifier
// itself: if the C11 `_Alignas` spelling stopped being accepted, the
// native compile would fail and the gate would DIFF. (The `alignas`
// spelling from <stdalign.h> is a preprocessor macro over `_Alignas`;
// the direct spelling is used so the coverage parse sees the node. A
// non-power-of-two or oversized alignment would be ill-formed — 16 is
// a plain valid alignment for int.)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    const _Alignas(16) int x = 5;
    printf("ok\n");
    return 0;
}
