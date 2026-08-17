# t21_null_coalesce_expression: the parenthesized twin of the t20 rung —
# the null_coalesce_expression node, the SAME `??` null-coalescing
# operator in a parenthesized command argument (`Write-Output ($x ??
# "d")`; the t20 file pins the OTHER node, null_coalesce_argument_expression,
# inside an argument_list `head($x ?? "d")` — verified against the CST
# that the two spellings parse as DIFFERENT nodes: the grammar reaches
# null_coalesce_expression inside a parenthesized_expression command
# element and in bare statement position, which stays REFUSED — the
# t17 statement-level precedent). Live pwsh 7.6.4 (verified
# 2026-08-14): the parens evaluate the coalesce to ONE object —
# `Write-Output ($x ?? "d")` with $x unset prints `d`, `Write-Output
# ($x ?? 7)` prints `7` — the standard v1 single-object echo mapping,
# so the command lowers to the coalesce If ALONE (the t20 machinery,
# minus the head flush; the A1 If is a statement, not an expression,
# so lowerCommand intercepts the element via lowerParenCoalesce). The
# t21 subset pins the paren as the command's ONLY element — a further
# argument would be a SECOND pipeline object (the multi-object shape
# stays outside the v1 single-object echo mapping; refuse > guess).
# Lowering: `LHS ?? RHS` is a NULL check with the t20 subset — a bare
# variable read LHS (UNSET in the subset: variables are never assigned
# in v1) and a literal string / decimal integer RHS — through the SAME
# condition semantics as if/while: pwsh reads $null (FALSY) and the A1
# store reads "" (FALSY), both take the default — `if (LHS) { echo LHS }
# else { echo RHS }`, the t07 If shape (cond/then/elsifs/else,
# byte-identical to the core's if emission; the then-branch echo is
# dead within the subset). The executed-stdout oracle matches live pwsh
# by construction: both print "d" then "7". Truthy pwsh automatics
# (`$true`) and a variable RHS DIVERGE and REFUSE — the t20 pins carry
# over (the same lowerCondVar / literal-default checks, both pinned in
# testdata_refuse/t20_*).
Write-Output ($x ?? "d")
Write-Output ($x ?? 7)
