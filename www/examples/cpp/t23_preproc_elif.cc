// t23_preproc_elif.cc — the preproc_elif node: the `#elif` arm of a
// preprocessor conditional (tree-sitter parses it as a named node
// between preproc_if and preproc_else, carrying its own condition and
// body). Whitelisted in parser.go (allowedKinds, alongside the rest of
// the conditional family preproc_if/preproc_ifdef/preproc_defined/
// preproc_else — the whitelist has always listed it, but no testdata
// example exercised it until now: t22's #if/#else chain has no #elif
// arm). Preprocessor lines are compile-time only: the tokenizer drops
// them before clib sees the C text, so the runtime program carries no
// trace of the conditional, exactly like the #include lines in every
// other example. The macros must stay UNUSED in code: clib compiles
// the dropped text, so a use would be an undefined identifier. Native
// g++ evaluates the chain (FOO and BAR are undefined, so the #else
// arm defines VERSION as 3 — a silent no-op, since nothing references
// it); both oracles print the same stdout.
#include <cstdio>
#if defined(FOO)
#define VERSION 1
#elif defined(BAR)
#define VERSION 2
#else
#define VERSION 3
#endif

int main() {
  printf("preproc elif ok\n");
  return 0;
}
