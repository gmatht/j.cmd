// t91_asm_operand: the grammars-v4 asmOperand/asmOperands rules — the
// operand bindings of a GNU asm statement (asmArgument's `:` sections:
// the constraint/operand pairs `"=r"(x)` / `"r"(y)`, and the clobbers
// list). A compile-time-only directive: the machine code it inserts is
// for the compiler, and the estree runtime cannot execute it — the v1
// frontend skips the statement (`asm volatile (...)` rides the
// statement-position bare-id skip to the `;`, same as t89), so the
// faithful lowering is no emitted code at all — the same family as the
// t85/t86/t88/t89/t90 attribute/qualifier/asm directives. The EMPTY
// template keeps the example portable (no target-specific instructions):
// gcc executes zero instructions, and the "+r"(x) read-write operand
// just round-trips x through a register, so x's value is unchanged on
// the native side too and stdout matches the JS side exactly. The
// gate's native side (gcc, GNU mode) validates the construct itself:
// if the asmOperand extension stopped being accepted, the native
// compile would fail and the gate would DIFF.
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int x = 5;
    asm volatile("" : "+r"(x));
    printf("%d\n", x);
    return 0;
}
