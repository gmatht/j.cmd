// t92_toplevel_asm: the grammars-v4 toplevelAsmArgument rule — the
// DECLARATOR-position asm label (`int x asm("myx");` — a
// gccDeclaratorExtension on the declaration, parsed as
// `asmDefinition: asm_ '(' toplevelAsmArgument ')'`). This is the only
// gcc-valid carrier of the rule: the other alternatives (file-scope
// `asm` with operand sections, `asm("nop" : "=r"(x));`) are a gcc
// syntax error at translation-unit level, so no oracle-passing program
// can exercise them. A compile-time-only directive with no runtime
// effect: the label only renames the SYMBOL in the object file — the
// variable's value (a zero-initialized tentative definition) is
// unchanged — so the v1 frontend's skip (the declaration rides the
// bare-declaration path and emits nothing; an unset var reads as 0) is
// the faithful lowering: no emitted code, same family as the
// t85/t86/t88/t89/t90/t91 attribute/qualifier/asm directives. The
// gate's native side (gcc, GNU mode) validates the construct itself:
// if the asm-label extension stopped being accepted, the native
// compile would fail and the gate would DIFF. (The A1 contract carries
// the label as the optional `Assign.asm` field — core request
// c-sh-go-toplevelasmargument-20260814-042952, estree no-op — but the
// frontend has no asm parse path yet; the WITH-initializer form
// `int x asm("myx") = 7;` would drop the initializer with the label,
// so only the effect-free bare form is exercised here.)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int x asm("myx");

int main(void) {
    printf("%d\n", x);
    return 0;
}
