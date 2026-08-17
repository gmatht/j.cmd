# t14_format: the format_argument_expression node of tree-sitter-
# powershell — the `-f` .NET composite-format operator in an argument
# list (`head("{0} {1}" -f "a","b")`; the plan's `-f` row,
# PLAN_POWERSHELL_F.md §1, "printf-style"). The grammar reaches this
# node ONLY inside an argument_list — the `(` argument_expression_list
# `)` attached to a command argument (verified against the CST; a
# parenthesized `Write-Output ("{0}" -f "a")` parses as the DIFFERENT
# format_expression node, and a bare `-f` in argument position is a
# command_parameter). Live pwsh 7.6.4 (verified 2026-08-13): the head
# argument and the parenthesized value(s) are SEPARATE pipeline objects
# — `Write-Output foo("{0} {1}" -f "a","b")` prints `foo` then `a b` on
# two lines — so the command lowers to ONE echo statement PER object
# (the A1 echo joins its own args with spaces on one line, which would
# miscompile the object-per-argument reality; the t05 quoted-head
# refusal stays — that multi-object shape is a tokenizer artifact,
# this one is the explicit parens).
# The t14 subset pins an ALL-LITERAL format: the format string and
# every argument are literal strings / decimal integers, so the
# formatted result is a COMPILE-TIME constant and `LHS -f args` folds
# to ONE A1 Str (the grammar parses the comma-list RHS as the format's
# RHS plus following argument_expression elements of the enclosing
# list, while pwsh takes the whole comma-list as the -f argument array
# — the lowering collects [RHS] + the following elements, the pwsh
# semantics). Bare `{N}` placeholders substitute the N-th argument;
# the `{1} {0}` line pins reordering. A variable anywhere (`"{0}" -f
# $x`), escaped braces, alignment/format specifiers (`{0:D2}`) and a
# placeholder/argument count mismatch REFUSE (the runtime printf-style
# rung is a later milestone; refuse > guess), as do a plain literal
# argument list (`foo("x")`), an empty `foo()` and an argument after
# the parens.
Write-Output foo("{0} {1}" -f "a","b")
Write-Output 5("{1} {0}" -f "x","y")
