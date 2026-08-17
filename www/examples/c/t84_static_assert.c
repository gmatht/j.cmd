// t84_static_assert: C11 static assertion — `_Static_assert(cond, "msg");`
// (the grammars-v4 staticAssertDeclaration rule). A compile-time-only
// declaration with NO runtime effect: the check happens at compile time
// (a false condition makes the program ill-formed). The v1 frontend
// parses the declaration as a call-form statement and skips it (the same
// no-runtime-effect handling as #include / return / va_start) — faithful
// for a TRUE assertion, since the faithful lowering of a compile-time
// check that holds is no emitted code at all. The gate's native side
// (gcc) enforces the check itself: if this assertion ever stopped
// holding, the native compile would fail and the gate would DIFF.
// diagnostics: program prints its result to stdout
#include <stdio.h>

_Static_assert(1 + 1 == 2, "one plus one is two");

int main(void) {
    printf("ok\n");
    return 0;
}
