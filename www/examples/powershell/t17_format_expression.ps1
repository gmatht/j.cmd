# t17_format_expression: the format_expression node of tree-sitter-
# powershell — the `-f` .NET composite-format operator in EXPRESSION
# position (`Write-Output ("{0}" -f "a")`; the plan's `-f` row,
# PLAN_POWERSHELL_F.md §1, "printf-style"). The t14 rung reached the
# operator only inside an argument_list (the format_argument_expression
# node); a parenthesized `Write-Output ("{0}" -f "a")` parses as the
# DIFFERENT format_expression node — the grammar reaches it in a
# parenthesized command argument (a bare `"{0}" -f "a"` statement is
# the same node and still REFUSES: statement-level expressions are the
# command-only rung). Live pwsh 7.6.4 (verified 2026-08-14): the parens
# evaluate the format to ONE object — `Write-Output ("{0}" -f "a")`
# prints `a`, `Write-Output ("{1} {0}" -f "x","y")` prints `y x` — the
# standard v1 single-object echo mapping, so the argument lowers to ONE
# echo of the folded value (the t14 object-per-argument split does NOT
# apply here — the paren is a single argument, not an argument list).
# The t17 subset pins the SAME all-literal fold as t14: the format
# string and every argument are literal strings / decimal integers, so
# `LHS -f args` folds to ONE compile-time A1 Str. In the paren the
# grammar parses the comma-list RHS as ONE array_literal_expression
# (the t14 list-split workaround does not apply) — the lowering
# collects its elements as the format's argument array, the pwsh
# semantics. Bare `{N}` placeholders substitute the N-th argument; the
# `{1} {0}` line pins reordering. A variable anywhere (`"{0}" -f $x`),
# a nested paren/format, escaped braces, alignment/format specifiers
# (`{0:D2}`), a placeholder/argument count mismatch and any NON-format
# parenthesized expression (`("a")` / `($x)`) REFUSE (the runtime
# printf-style rung is a later milestone; refuse > guess).
Write-Output ("{0}" -f "a")
Write-Output ("{1} {0}" -f "x","y")
