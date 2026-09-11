// t24_preproc_function_def.cc — the preproc_function_def node: a
// function-like macro, `#define NAME(params) body` (tree-sitter parses
// the `(params)` list as a preproc_params child and the body as
// preproc_arg — both whitelisted alongside preproc_function_def in
// parser.go allowedKinds). Whitelisted since v0.1, but no testdata
// example exercised it until now: t20's `#define LIMIT 5` is an
// object-like macro (preproc_def). Preprocessor lines are compile-time
// only: the tokenizer drops them before clib sees the C text, so the
// runtime program carries no trace of the macro, exactly like the
// #include lines in every other example. The macro must stay UNUSED in
// code: clib compiles the dropped text, so a use would be an undefined
// identifier. Native g++ consumes the #define; both oracles print the
// same stdout.
#include <cstdio>
#define SQUARE(x) ((x) * (x))

int main() {
  printf("preproc function def ok\n");
  return 0;
}
