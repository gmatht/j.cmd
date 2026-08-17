# t36_arithmetic: the additive_expression / multiplicative_expression
# nodes of tree-sitter-powershell — the binary arithmetic operators in a
# PARENTHESIZED command argument (`Write-Output (1 + 2)`; the grammar
# reaches the arithmetic nodes exactly in this parenthesized command
# element and in bare statement position, which stays REFUSED — the t17
# statement-level precedent; inside an argument_list the operators parse
# as the DIFFERENT additive_argument_expression /
# multiplicative_argument_expression nodes, which stay REFUSED on the
# t14 machinery — the t14/t24/t32 host). The A1 Arith node (the plan's
# "`+ - * / %` (numeric) → the Arith AST" row, PLAN_POWERSHELL_F.md §1;
# the planned t03_arith.ps1 surface) is the construct this example
# exercises: the core's `echo $((1+2))` emission, byte-identical.
# Live pwsh 7.6.4 (verified 2026-08-24): the parens evaluate the
# arithmetic to ONE object — `Write-Output (1 + 2)` prints `3`, `7 - 2`
# → 5, `2 * 3` → 6, `7 % 3` → 1, `1 + 2 * 3` → 7 (precedence), `1 + 2 +
# 3` → 6 (left associativity) — the standard v1 single-object echo
# mapping, so the command lowers to ONE echo of the A1 Arith expression.
# The A1→ESTree renderer lowers + - * to native JS arithmetic and % to
# the bash-semantics runtime helper, and on INTEGER operands that agrees
# with pwsh by construction — the executed-stdout oracle matches live
# pwsh (both print 3, 5, 6, 1, 7, 6).
# The t36 subset pins an ALL-LITERAL arithmetic: every operand is a
# bare decimal integer_literal (or a nested expression of the same
# shape — the precedence / associativity pins above), so the ArithAst
# is a compile-time Num/Bin tree with NO variables — pwsh arithmetic is
# overloaded (string concat, $null→0 coercion, real division) and a
# variable / string / real / hex / cast / unary-operator operand would
# DIVERGE from the A1's bash-integer semantics (refuse > guess; the
# divergent edges are pinned in testdata_refuse/). `/` REFUSES — pwsh
# 7.6.4 REAL division (`Write-Output (7 / 2)` prints 3.5) vs the A1
# Arith's bash INTEGER division (Math.trunc — the transpiled run prints
# 3) — as does `\` (pwsh integer division; the A1 ArithAst has no such
# operator). The t36 subset pins the paren as the command's ONLY
# element — a further argument would be a SECOND pipeline object (the
# multi-object shape stays outside the v1 single-object echo mapping;
# refuse > guess, the t21/t25/t33 precedent).
Write-Output (1 + 2)
Write-Output (7 - 2)
Write-Output (2 * 3)
Write-Output (7 % 3)
Write-Output (1 + 2 * 3)
Write-Output (1 + 2 + 3)
