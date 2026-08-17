// t89_asm_qualifier: the grammars-v4 asmQualifier rule — `volatile` (or
// `inline`) in a GCC asm statement (`asm volatile ("...")`). A compile-
// time-only directive with NO runtime effect: the asm block is machine
// code for the compiler, it never changes C-level stdout. The v1
// frontend skips it (the statement-position bare-id skip: `asm` parses
// as an id and the whole `asm volatile ("nop");` rides the skip to the
// `;`), so the faithful lowering is no emitted code at all — the same
// family as the t85/t86/t88 attribute/qualifier directives. The gate's
// native side (gcc, GNU mode) validates the construct itself: if the
// `asm volatile` extension stopped being accepted, the native compile
// would fail and the gate would DIFF.
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int x = 5;
    asm volatile ("nop");
    printf("%d\n", x);
    return 0;
}
