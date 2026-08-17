# t33_ternary_expression: the ternary_expression node of
# tree-sitter-powershell — the `? :` ternary operator in a
# PARENTHESIZED command argument (`Write-Output ($x ? "a" : "b")`).
# The grammar reaches this node ONLY inside a parenthesized_expression
# command element and in bare statement position (which stays REFUSED
# — the t17 statement-level precedent); the t32 file pins the OTHER
# node, ternary_argument_expression, inside an argument_list
# (`head($x ? "a" : "b")`) — verified against the CST that the two
# spellings parse as DIFFERENT nodes with IDENTICAL child structure
# (unary_expression, `?`, unary_expression, `:`, unary_expression —
# plus the anonymous `?` / `:` operator tokens; a bare `?` in
# argument position is a command_parameter).
# Live pwsh 7.6.4 (verified 2026-08-21): the parens evaluate the
# ternary to ONE object — `Write-Output ($x ? "a" : "b")` with $x
# unset prints `b`, `Write-Output ($x ? 7 : "d")` prints `d` — the
# standard v1 single-object echo mapping, so the command lowers to the
# ternary If ALONE (the t32 machinery, shared through lowerTernary,
# minus the head flush; the A1 If is a statement, not an expression,
# so lowerCommand intercepts the element via lowerParenTernary). The
# t33 subset pins the paren as the command's ONLY element — a further
# argument would be a SECOND pipeline object (the multi-object shape
# stays outside the v1 single-object echo mapping; refuse > guess).
# Lowering: `C ? A : B` is a CONDITIONAL, and the t33 subset pins the
# t32 condition shape — a bare variable read condition (UNSET in the
# subset: variables are never assigned in v1) and a literal string /
# decimal integer on EACH branch (the t20 literal-default discipline)
# — so the ternary lowers through the SAME condition semantics as
# if/while: pwsh reads $null (FALSY) and the A1 store reads "" (FALSY),
# both take the else branch — `if (C) { echo A } else { echo B }`, the
# t07 If shape (cond/then/elsifs/else, byte-identical to the core's if
# emission; the then-branch echo is dead within the subset, where
# every variable reads falsy). The executed-stdout oracle matches live
# pwsh by construction: both print "b" then "d" (and "9" — the
# integer ELSE branch, exercised at runtime — on the last line).
# Truthy pwsh automatics (`$true`) and a variable branch DIVERGE and
# REFUSE — the t32 pins carry over through the shared lowerTernary /
# lowerCondVar / ternaryBranch checks (the parenthesized spellings of
# testdata_refuse/t32_ternary_true_cond.ps1 and
# testdata_refuse/t32_ternary_var_branch.ps1 refuse identically), as
# do a chained `($x ? "a" : $y ? "b" : "c")` (a NESTED ternary branch —
# the operand-shape check refuses) and a non-literal branch (refuse >
# guess).
Write-Output ($x ? "a" : "b")
Write-Output ($x ? 7 : "d")
Write-Output ($x ? "a" : 9)
