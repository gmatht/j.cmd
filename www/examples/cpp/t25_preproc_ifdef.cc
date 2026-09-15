// t25_preproc_ifdef.cc — the preproc_ifdef node: `#ifdef NAME` /
// `#ifndef NAME` (tree-sitter-cpp parses both spellings as a
// preproc_ifdef, carrying the tested identifier as a child and an
// optional preproc_else arm). Whitelisted in parser.go (allowedKinds,
// alongside the rest of the conditional family preproc_if/
// preproc_defined/preproc_elif/preproc_else — no testdata example
// exercised it until now: t22's `#if defined(FOO)` chain parses as
// preproc_if, and only t23's `#elif` arm is preproc_elif). Preprocessor
// lines are compile-time only: the tokenizer drops them before clib
// sees the C text, so the runtime program carries no trace of the
// conditional, exactly like the #include lines in every other example.
// The macros must stay UNUSED in code: clib compiles the dropped text,
// so a use would be an undefined identifier. Native g++ evaluates the
// test (FOO is undefined, so the #else arm defines VERSION as 2 — a
// silent no-op, since nothing references it); both oracles print the
// same stdout.
#include <cstdio>
#ifdef FOO
#define VERSION 1
#else
#define VERSION 2
#endif

int main() {
  printf("preproc ifdef ok\n");
  return 0;
}
