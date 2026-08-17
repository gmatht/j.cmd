# t11_exit: the flow_control_statement node of tree-sitter-powershell —
# the `exit` keyword form (`exit` / `exit N`). The grammar's
# flow_control_statement admits FIVE keyword statements — break /
# continue / throw / return / exit, each with an optional tail (a
# label_expression for break/continue, a pipeline for throw/return/
# exit); this pin lands the EXIT form (the plan's `exit N` row,
# PLAN_POWERSHELL_F.md §1 — "the Exit statement (all backends render
# it)"). Live pwsh 7.6.4: `exit 5` terminates the script with status 5
# — the statements after it never run (verified: "before" prints,
# "after" does not, exit code 5). Lowering: the A1 Exit statement —
# `{"type":"Exit","value":{"type":"Int","value":5}}` — the bat
# frontend's `exit /b N` precedent (bat-sh-go parseExit; the A1->ESTree
# renderer emits process.exit(Number(5)), which terminates the node run
# before the second echo). The executed-stdout oracle compares the
# transpiled run against live pwsh: both print "before" and stop. A
# bare `exit` (no code) lowers with value: null — the lastExit channel,
# same as bat; `exit $x` / `exit -1` (expression_with_unary_operator)
# REFUSE (the subset pins a bare decimal integer).
# The other four keyword forms REFUSE (testdata_refuse/t11-t14): break
# and continue are loop signals whose only v1 loop host (the t06
# do-while duplication) lowers the body OUTSIDE the loop — emitting
# them would miscompile (the while/for rungs host them); return is the
# function rung's value channel; throw is the exception model (the A1
# has no exceptions).
Write-Output "before"
exit 5
Write-Output "after"
