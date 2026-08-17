// t90_simple_asm: the grammars-v4 simpleAsmExpr rule — the SIMPLE GNU
// asm form at FILE SCOPE: `asm ( "..." )` with no qualifiers and no
// operands (the qualified statement form `asm volatile ("nop")` is
// t89's asmStatement/asmQualifier coverage). As a file-scope external
// declaration the official grammar parses it as asmDefinition →
// simpleAsmExpr. A compile-time-only directive with no runtime effect:
// the machine code it inserts is for the compiler, it never changes
// C-level stdout. The v1 frontend skips it (a file-scope `asm` parses
// as an unknown call statement and emits nothing), so the faithful
// lowering is no emitted code at all — the same family as the
// t85/t86/t88/t89 attribute/qualifier/asm directives. The gate's
// native side (gcc, GNU mode) validates the construct itself: if the
// file-scope simple asm extension stopped being accepted, the native
// compile would fail and the gate would DIFF.
// diagnostics: program prints its result to stdout
#include <stdio.h>

asm("nop");

int main(void) {
    int x = 5;
    printf("%d\n", x);
    return 0;
}
