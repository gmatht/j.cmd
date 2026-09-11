// t101_switch_default_break: a switch whose DEFAULT arm ends with a
// `break` — the trailing break binds to the SWITCH (no loop), so the
// if-chain lowering must strip it: an emitted A1 Break outside a loop
// is an uncaught BREAK signal in the runtime (t15_switch class).
// diagnostics: prints other two
#include <stdio.h>
int main(void) {
    int x = 9;
    switch (x) {
        case 1: printf("one\n"); break;
        default: printf("other\n"); break;
    }
    x = 1;
    switch (x) {
        default: printf("other\n"); break;
        case 1: printf("one2\n"); break;
    }
    printf("two\n");
    return 0;
}
