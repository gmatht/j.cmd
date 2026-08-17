# t32_ternary: the ternary_argument_expression node of
# tree-sitter-powershell — the `? :` ternary operator in an argument
# list (`head($x ? "a" : "b")`). The grammar reaches this node ONLY
# inside an argument_list — the `(` argument_expression_list `)`
# attached to a command argument (verified against the CST: the node
# has THREE named children — the condition and the two branches, all
# unary_expression — plus the anonymous `?` / `:` operator tokens; a
# parenthesized `Write-Output ($x ? "a" : "b")` parses as the DIFFERENT
# ternary_expression node, still refused, and a bare `?` in argument
# position is a command_parameter). Live pwsh 7.6.4 (verified
# 2026-08-21): the head argument and the ternary value are SEPARATE
# pipeline objects — `Write-Output foo($x ? "a" : "b")` prints `foo`
# then `b` (with $x unset) — so the command lowers to ONE echo per
# object (the t14 one-object-per-argument rule; the head flush is the
# t14 machinery), the ternary itself being ONE object.
# Lowering: `C ? A : B` is a CONDITIONAL, and the t32 subset pins the
# t06/t07 condition shape — a bare variable read condition (UNSET in
# the subset: variables are never assigned in v1) and a literal
# string / decimal integer on EACH branch (the t20 literal-default
# discipline) — so the ternary lowers through the SAME condition
# semantics as if/while: pwsh reads $null (FALSY) and the A1 store
# reads "" (FALSY), both take the else branch — `if (C) { echo A }
# else { echo B }`, the t07 If shape (cond/then/elsifs/else,
# byte-identical to the core's if emission; the then-branch echo is
# dead within the subset). The executed-stdout oracle matches live
# pwsh by construction: both print "foo" then "b" (and "5" then "d"
# on the integer-then line, and "baz" then "9" — the integer ELSE
# branch, exercised at runtime — on the last line). Truthy pwsh
# automatics (`$true`) and a variable branch DIVERGE and REFUSE —
# `$true ? "a" : "b"` prints the then-branch a in pwsh vs the
# falsy-lowering's b, and `$x ? "a" : $y` with both unset evaluates
# to $null (`Write-Output` of a bare $null prints NOTHING — the t02
# PRINT edge) — pinned in testdata_refuse/t32_ternary_true_cond.ps1
# and testdata_refuse/t32_ternary_var_branch.ps1; a chained
# `$x ? "a" : $y ? "b" : "c"` parses as a NESTED
# ternary_argument_expression branch and REFUSES on the operand-shape
# check (refuse > guess).
Write-Output foo($x ? "a" : "b")
Write-Output 5($x ? 7 : "d")
Write-Output baz($x ? "a" : 9)
