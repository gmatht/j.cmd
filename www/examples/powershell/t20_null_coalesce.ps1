# t20_null_coalesce: the null_coalesce_argument_expression node of
# tree-sitter-powershell — the `??` null-coalescing operator in an
# argument list (`head($x ?? "d")`). The grammar reaches this node ONLY
# inside an argument_list — the `(` argument_expression_list `)`
# attached to a command argument (verified against the CST; a
# parenthesized `Write-Output ($x ?? "d")` parses as the DIFFERENT
# null_coalesce_expression node, still refused, and a bare `??` in
# argument position is a command_parameter). Live pwsh 7.6.4 (verified
# 2026-08-15): the head argument and the coalesced value are SEPARATE
# pipeline objects — `Write-Output foo($x ?? "d")` prints `foo` then
# `d` (with $x unset) — so the command lowers to ONE echo per object
# (the t14 one-object-per-argument rule; the head flush is the t14
# machinery).
# Lowering: `$x ?? "d"` is a NULL check, and the t20 subset pins the
# t06/t07 condition shape — a bare variable read LHS (UNSET in the
# subset: variables are never assigned in v1) and a literal string /
# decimal integer RHS (a NON-null constant) — so `LHS ?? RHS` lowers
# through the SAME condition semantics as if/while: pwsh reads $null
# (FALSY) and the A1 store reads "" (FALSY), both take the default —
# `if (LHS) { echo LHS } else { echo RHS }`, the t07 If shape
# (cond/then/elsifs/else, byte-identical to the core's if emission;
# the then-branch echo is dead within the subset). The executed-stdout
# oracle matches live pwsh by construction: both print "foo" then "d"
# (and "5" then "7" on the integer-default line). Truthy pwsh
# automatics (`$true`) and a variable RHS DIVERGE and REFUSE —
# `$true ?? "d"` prints True in pwsh vs the falsy-lowering's d, and
# `$x ?? $y` with both unset coalesces to $null (`Write-Output` of a
# bare $null prints NOTHING — the t02 PRINT edge) — pinned in
# testdata_refuse/t20_null_coalesce_true_lhs.ps1 and
# testdata_refuse/t20_null_coalesce_var_rhs.ps1.
Write-Output foo($x ?? "d")
Write-Output 5($x ?? 7)
