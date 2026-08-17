# t06_do_statement: the do_statement node of tree-sitter-powershell —
# `do { … } while (cond)` (do + statement_block + `while` keyword +
# `(` while_condition `)`; the condition's pipeline_chain is a bare
# unary_expression → variable). Live pwsh 7.6.4 semantics: the body
# runs ONCE, then the condition is re-checked. The plan's lowering is
# "the do-while duplication" (PLAN_POWERSHELL_F.md §1): `do { B }
# while (C)` ≡ `B; while (C) { B }` — byte-identical to the core's
# While statement shape. (The A1 DoWhile node is Perl-only in the
# ESTree renderer — "Perl-only IR statement reached the ESTree
# renderer" — so the duplication keeps the construct on the node the
# renderer supports; the equivalence is exact, the body executes once
# either way.)
# The condition is a bare variable read, pinned for an UNSET variable
# (the t02 ${foo} precedent): pwsh reads $null (FALSY) and the A1
# store reads "" (FALSY) — the condition-position null edge is
# CONSISTENT (unlike the t02 PRINT edge, where `Write-Output $x`
# prints nothing vs the A1 echo's blank line — that print edge stays
# outside the subset). So the body prints once on both sides. Truthy
# pwsh automatic variables in a condition (`$true`, `$PID`, …) DIVERGE
# (pwsh truthy → infinite loop, A1 getVar → "" → falsy) — `$true`
# REFUSES (testdata_refuse/t03_do_while_true.ps1); `$false`/`$null`
# are consistent (both falsy) but unpinned; the `until` keyword form
# of the same node REFUSES (testdata_refuse/t02_do_until.ps1).
do { Write-Output "once" } while ($x)
