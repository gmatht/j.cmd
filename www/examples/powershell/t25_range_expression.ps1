# t25_range_expression: the range_expression node of tree-sitter-
# powershell — the `..` range operator in a PARENTHESIZED command
# argument (`Write-Output (1 .. 3)`; the grammar reaches this node
# inside a parenthesized_expression — the parenthesized twin of the
# t24 range_argument_expression, which the grammar reaches ONLY inside
# an argument_list; in the paren the `..` must lex as its OWN token, so
# the range needs the SPACED spelling `1 .. 3` — the unspaced `(1..3)`
# lexes the whole text as ONE command_name token and parses as a
# `command` node instead, verified against the CST). Live pwsh 7.6.4
# (verified 2026-08-14): the paren evaluates the range to an ARRAY
# whose elements are enumerated as SEPARATE pipeline objects —
# `Write-Output (1 .. 3)` prints `1`, `2`, `3` on THREE lines — so the
# argument lowers to ONE echo statement PER ELEMENT (the t24 fold,
# shared through lowerRange: the t14 one-object-per-argument rule,
# extended — the range is an array of objects, not one object).
# The t25 subset pins the SAME all-literal fold as t24: both bounds
# are bare decimal integers, so the element list is a COMPILE-TIME
# constant (the t14 constant-fold precedent) — ascending `(1 .. 3)`
# emits 1 2 3, descending `(3 .. 1)` emits 3 2 1 (verified against
# live pwsh) — and the paren is the command's ONLY element (the t21
# precedent: a further argument would be another pipeline object —
# refuse > guess). The t24 refuse edges carry over by construction
# (the shared lowerRange): a variable / non-decimal bound (`(1 .. $x)`
# — pinned testdata_refuse/t25_range_expression_var_bound.ps1), a
# chained range (`(1 .. 3 .. 5)`), a span beyond the fold cap and a
# head/tail argument all REFUSE (the runtime array rung is a later
# milestone — the A1 Range bounded-iterable node is the shape that
# rung needs; refuse > guess). The executed-stdout oracle matches live
# pwsh by construction: both print 1, 2, 3 then 3, 2, 1.
Write-Output (1 .. 3)
Write-Output (3 .. 1)
