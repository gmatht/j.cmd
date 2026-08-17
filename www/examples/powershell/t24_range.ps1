# t24_range: the range_argument_expression node of tree-sitter-
# powershell — the `..` range operator in an argument list
# (`head(1..3)`; the grammar reaches this node ONLY inside an
# argument_list — the argument_expression alternative at the bottom of
# the precedence chain, the t14/t20 host, verified against the CST; a
# parenthesized `Write-Output (1..3)` parses as the DIFFERENT
# range_expression node, still refused, and a bare `1..3` in argument
# position parses as separate command arguments). Live pwsh 7.6.4
# (verified 2026-08-17): the range evaluates to an ARRAY whose
# elements are enumerated as SEPARATE pipeline objects — `Write-Output
# foo(1..3)` prints `foo`, `1`, `2`, `3` on FOUR lines — so the
# argument lowers to ONE echo statement PER ELEMENT (the t14
# one-object-per-argument rule, extended: the range is an array of
# objects, not one object).
# The t24 subset pins an ALL-LITERAL range: both bounds are bare
# decimal integers, so the element list is a COMPILE-TIME constant
# (the t14 constant-fold precedent) — ascending `1..3` emits 1 2 3,
# descending `3..1` emits 3 2 1 (verified against live pwsh; the t14
# `{1} {0}` reordering pin's sibling). The executed-stdout oracle
# matches live pwsh by construction: both print foo, 1, 2, 3 (the
# bareword head line) and 5, 3, 2, 1 (the integer head line). A
# variable or non-decimal bound (`$a..3`), a chained range
# (`1..3..5`), a following comma-list element and a span beyond the
# fold cap REFUSE (the runtime array rung is a later milestone — the
# A1 Range bounded-iterable node is the shape that rung needs; refuse
# > guess), the variable bound pinned in
# testdata_refuse/t24_range_var_bound.ps1.
Write-Output foo(1..3)
Write-Output 5(3..1)
