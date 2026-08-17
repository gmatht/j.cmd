# t12_for_condition: the for_condition node of tree-sitter-powershell —
# the condition clause of a for_statement (`for` `(` [for_initializer]
# `;` for_condition `;` [for_iterator] `)` statement_block; the grammar
# admits ANY subset of the three clauses, and the t12 rung pins the
# CONDITION-ONLY form `for (; $c; ) { B }`). Live pwsh 7.6.4: with
# empty init/iter clauses a for loop IS a while loop, and the lowering
# is exactly that — `for (; $c; ) { B }` → the A1 While statement
# `while ($c) { B }`, byte-identical to the t06 do-while duplication's
# While shape (the same whileStmt). The for_condition node has the
# SAME single-pipeline shape as while_condition (verified against
# node-types.json), so it lowers through the same lowerCondition /
# lowerCondPipeline — the t06/t07 condition subset: a bare variable
# read.
# The condition is pinned for an UNSET variable (the t06/t07
# precedent): pwsh reads $null (FALSY) and the A1 store reads ""
# (FALSY) — the condition-position null edge is CONSISTENT — so the
# body NEVER runs on either side and the executed-stdout oracle
# compares the transpiled run against live pwsh (both print only
# "after"; the body echo is structural — a wrongly-run body would
# DIFF). Truthy pwsh automatics ($true, …) DIVERGE exactly as in a
# while condition and refuse through the same lowerCondPipeline gate;
# the for_initializer / for_iterator clauses and the conditionless
# `for (;;)` REFUSE — pinned testdata_refuse/t12_for_init_iter.ps1 +
# t12_for_conditionless.ps1 (the plan's full for row — the C
# frontend's init/cond/update → while lowering — lands with the
# assignment rung).
for (; $x; ) { Write-Output "in-loop" }
Write-Output "after"
