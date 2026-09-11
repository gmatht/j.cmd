// t22_preproc_defined.cc — the preproc_defined node: the `defined(X)`
// test in an #if/#elif condition (tree-sitter parses it as a named
// child of preproc_if/preproc_elif, wrapping a plain identifier).
// Whitelisted in parser.go (allowedKinds, alongside the rest of the
// conditional family preproc_if/preproc_ifdef/preproc_elif/
// preproc_else — it was the one named node of that family the
// whitelist had missed), and preprocessor lines are compile-time only:
// the tokenizer drops them before clib sees the C text, so the runtime
// program carries no trace of the conditional, exactly like the
// #include lines in every other example. The macros must stay UNUSED
// in code: clib compiles the dropped text, so a use would be an
// undefined identifier. Native g++ evaluates the condition (FOO is
// undefined, so the #else arm defines VERSION as 2 — a silent no-op,
// since nothing references it); both oracles print the same stdout.
#include <cstdio>
#if defined(FOO)
#define VERSION 1
#else
#define VERSION 2
#endif

int main() {
  printf("preproc defined ok\n");
  return 0;
}
