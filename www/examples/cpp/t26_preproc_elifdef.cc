// t26_preproc_elifdef.cc — the preproc_elifdef node: the `#elifdef NAME`
// arm of a preprocessor conditional (tree-sitter-cpp parses both the
// `#elifdef` and `#elifndef` spellings as a preproc_elifdef, carrying
// the tested identifier as its `name` child and an optional
// preproc_else arm). Whitelisted in parser.go (allowedKinds, alongside
// the rest of the conditional family preproc_if/preproc_ifdef/
// preproc_defined/preproc_elif/preproc_else — it was the one named node
// of that family the whitelist had missed, and no testdata example
// exercised it until now: t23's `#elif` arm is preproc_elif, while the
// `#elifdef`/`#elifndef` spellings are the C++23 macro-name variants
// (accepted by g++ as an extension in earlier modes)). Preprocessor
// lines are compile-time only: the tokenizer drops them before clib
// sees the C text, so the runtime program carries no trace of the
// conditional, exactly like the #include lines in every other example.
// The macros must stay UNUSED in code: clib compiles the dropped text,
// so a use would be an undefined identifier. Native g++ evaluates the
// chain (FOO and BAR are undefined, so the #else arm defines VERSION
// as 3 — a silent no-op, since nothing references it); both oracles
// print the same stdout.
#include <cstdio>
#ifdef FOO
#define VERSION 1
#elifdef BAR
#define VERSION 2
#else
#define VERSION 3
#endif

int main() {
  printf("preproc elifdef ok\n");
  return 0;
}
