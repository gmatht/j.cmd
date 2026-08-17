// t86_attribute_arg_clause: C2x attribute ARGUMENT CLAUSE — the
// `( balancedTokenSequence? )` part of a C23 `[[...]]` attribute, in
// its enumerator position (the grammars-v4 attributeArgumentClause
// rule; t85 covers the argument-less `[[maybe_unused]]`). The clause
// is compile-time-only metadata with NO runtime effect: it is a
// compiler hint, never stdout. The argument is a balanced-token
// sequence — `foo(())` — rather than a real attribute's string
// literal (`[[deprecated("msg")]]`) because the vendored grammars-v4
// balancedToken rule only matches nested `() [] {}` (its "any token
// other than a parenthesis, bracket, or brace" alternative is a
// COMMENT, not a parser alternative): a string argument would fail
// the coverage parse. `foo` is an unknown attribute-token, which is
// valid C23 — an implementation ignores attribute-tokens it does not
// recognize (gcc warns "'foo' attribute ignored" and compiles; a
// real attribute rejects `(())` with "expected string literal").
// The v1 frontend parses the enum declaration and skips it (the t80
// enum gap — enumerator values are not folded), so the attribute AND
// its argument clause ride the same skip: the faithful lowering of a
// compile-time-only directive is no emitted code at all. Only the
// first enumerator (A = 0) prints a matching stdout; B would
// mis-lower to an unset var (the documented enum gap). The gate's
// native side (gcc) validates the attribute specifier itself: if the
// C23 spelling stopped being accepted, the native compile would fail
// and the gate would DIFF. (The specifier/declarator positions —
// `[[attr(...)]] int y;` / the GNU `__attribute__` forms — REFUSE by
// design, PARSER_GAPS.md: attributes are a by-design refusal outside
// the v1 subset.)
// diagnostics: program prints its result to stdout
#include <stdio.h>

enum E { A [[foo(())]], B };

int main(void) {
    printf("%d\n", A);
    return 0;
}
