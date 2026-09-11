// t21_preproc_call.cc — the preproc_call node: any `#directive` that is
// not #include (preproc_include), #define (preproc_def/
// preproc_function_def) or a conditional (#if/#ifdef/#elif/#else:
// preproc_if/preproc_ifdef/preproc_elif/preproc_else). #pragma, #error,
// #warning and #line all parse as preproc_call (with preproc_directive +
// preproc_arg children). Whitelisted in parser.go (allowedKinds), and
// preprocessor lines are compile-time only — the tokenizer drops them
// before clib sees the C text (like the #include lines in every other
// example). #pragma once is the harmless pick: #error would fail native
// g++ outright, and #warning/#line would add compiler stderr noise —
// both oracles must print the same stdout, so the directive must be a
// silent no-op on the native side. The pragma must stay UNUSED in code:
// clib compiles the dropped text, so a referenced macro would be an
// undefined identifier.
#include <cstdio>
#pragma once

int main() {
  printf("preproc call ok\n");
  return 0;
}
