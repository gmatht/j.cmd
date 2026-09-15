// t30_static_assert.cc — the static_assert_declaration node: a
// compile-time assertion (C++11+). static_assert has NO runtime
// effect — the program only compiles when the condition holds — so
// the declaration is dropped at the token level (main.go
// dropStaticAssert) before clib sees the C text, exactly like the
// preprocessor lines in t20–t26: the runtime program carries no
// trace of the assertion, and both oracles print the same stdout.
// Whitelisted in parser.go (allowedKinds); the condition's expression
// nodes (sizeof_expression, binary_expression, primitive_type) were
// already expressible. Native g++ evaluates the assertion at compile
// time (sizeof(int) >= 2 holds on every conforming platform).
#include <cstdio>
static_assert(sizeof(int) >= 2, "int is at least 2 bytes");

int main() {
  printf("static assert ok\n");
  return 0;
}
