// t20_preproc_arg.cc — the preproc_arg node: the raw body of a
// #define (and of #error/#pragma). Whitelisted in parser.go
// (allowedKinds), and preprocessor lines are compile-time only — the
// tokenizer drops them before clib sees the C text (the runtime
// program carries no trace of the macro, exactly like the #include
// lines in every other example). The macro must stay UNUSED in code:
// clib compiles the dropped text, so a use would be an undefined
// identifier. Native g++ consumes the #define; both oracles print the
// same stdout.
#include <cstdio>
#define LIMIT 5

int main() {
  printf("preproc arg ok\n");
  return 0;
}
