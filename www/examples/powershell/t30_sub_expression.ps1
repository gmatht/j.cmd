# t30_sub_expression: the sub_expression node — the `$(…)` subexpression
# inside an expandable string (`Write-Output "a $(Write-Output b) c"`;
# the grammar reaches the node as a named child of
# expandable_string_literal / expandable_here_string_literal — the t01
# string rung's interior — and in other positions it stays REFUSED: a
# bare `Write-Output $(…)` is a command-element expression (the t05
# concatenated-argument pin's `$(…)` piece and lowerCommandElement's
# default), and a `$(…)` piece inside a concatenated_command_argument
# refuses on the t05 machinery). Live pwsh 7.6.4 (verified 2026-08-20):
# the subexpression evaluates its statements and interpolates their
# OUTPUT — `Write-Output "a $(Write-Output b) c"` prints `a b c` —
# EXACTLY the core's bash command-substitution semantics, so the
# lowering is the A1 capture Call: the core emits `echo "a $(echo b)
# c"` as exec echo with an Interpolate part whose expr is the capture
# (`{"func":"capture","args":[{"type":"Arrow","body":[Expr echo b]}],
# "purity":"Spawn","type":"Call"}`, verified against `debashc --shir
# --raw` — byte-identical), the A1→ESTree renderer lowers that shape
# to a runtime capture, and the executed-stdout oracle matches live
# pwsh by construction (both print `a b c`). The t30 subset pins the
# body as exactly ONE plain command (the t26 chainOperand precedent):
# a multi-statement body (`"$(a; b)"`) would emit several statements
# whose capture-join semantics are unpinned — refuse > guess — and the
# body statement goes through the usual pipeline → command lowering
# (the t01 echo whitelist). The here-string twin (`@"a $(…) c"@`)
# lowers through the SAME capture shape (the t10 fold is shared).
Write-Output "a $(Write-Output b) c"
