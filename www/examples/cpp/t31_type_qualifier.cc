// t31_type_qualifier.cc — the tree-sitter-cpp type_qualifier node:
// `const` / `volatile` on a declaration. Whitelisted in parser.go
// (allowedKinds) and passed through the tokenizer as a plain
// identifier, so the cpp surface EXPRESSES the qualifier; the shared C
// lowering keeps its documented typeQualifier gap (PARSER_GAPS.md:
// `const int x = 5;` emits NO assign — x reads as unset), so only
// 0-valued inits print a matching stdout, exactly like the C corpus
// pins t82_const.c / t87_volatile.c; a non-zero init would mis-lower
// (native != transpiled) — the documented gap. `plain` proves the
// surrounding pipeline is live (a dropped declaration would DIFF).
#include <cstdio>
int main() {
  const int x = 0;
  volatile int y = 0;
  int plain = 7;
  printf("const %d volatile %d plain %d\n", x, y, plain);
  return 0;
}
