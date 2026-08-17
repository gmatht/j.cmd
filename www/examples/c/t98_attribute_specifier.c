// t98_attribute_specifier: GNU `__attribute__((...))` in its enum-
// trailing position — the tree-sitter-c `attribute_specifier` node
// (`__attribute__ '(' argument_list ')'`; the C23 `[[...]]` spelling is
// the SEPARATE `attribute_declaration` node, covered by t85/t86). A
// compile-time-only directive with NO runtime effect: the attribute is
// a compiler hint (here `packed` on an enum) that never changes stdout.
// The enum-trailing spot (`enum E { A, B } __attribute__((packed));`)
// is the ONE position the v1 frontend expresses: `enum` is not a
// statement keyword, so the whole declaration rides the statement-
// position bare-id skip to the `;` (the same no-runtime-effect
// handling as t80's enum skip / t82's const / t84 _Static_assert /
// t89's asm volatile) — the faithful lowering of a compile-time-only
// directive is no emitted code at all, and stdout comes from code the
// frontend fully expresses. (The specifier/declarator positions —
// `__attribute__((unused)) int x;` / `int x __attribute__((unused));`
// / `__attribute__((noreturn)) void f();` — REFUSE by design: the
// statement parser reads a leading `__attribute__(...)` as a call
// statement and chokes on the trailing type. The enum-INTERIOR GNU
// form of t88 (`A __attribute__((unused)), B`) parses as a tree-sitter
// ERROR node instead — the enumerator rule has no attribute position —
// which is why the enum-TRAILING spelling is the one that exercises
// the `attribute_specifier` node.) The gate's native side (gcc)
// validates the attribute itself: if the GNU `__attribute__` spelling
// stopped being accepted, the native compile would fail and the gate
// would DIFF.
// diagnostics: program prints its result to stdout
#include <stdio.h>

enum E { A, B } __attribute__((packed));

int main(void) {
    printf("ok\n");
    return 0;
}
