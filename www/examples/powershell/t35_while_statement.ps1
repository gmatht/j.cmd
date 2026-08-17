# t35_while_statement: the while_statement node of tree-sitter-powershell —
# `while` `(` while_condition `)` statement_block (the `while` keyword and
# the parens are anonymous alias tokens; the named children are the
# while_condition field and the body). The t06 do-while duplication's
# re-check shape and the t12 condition-only for BOTH emit this node's
# While, so `while ($c) { B }` lowers to the A1 While statement
# directly — the same whileStmt, byte-identical to the core's `while`
# emission. The while_condition node is the SAME node type the t06
# do_statement's re-check uses (verified against node-types.json), so
# the condition lowers through the same lowerCondition /
# lowerCondPipeline — the t06/t07 condition subset: a bare variable
# read.
# The condition is pinned for an UNSET variable (the t06/t07/t12
# precedent): pwsh reads $null (FALSY) and the A1 store reads ""
# (FALSY) — the condition-position null edge is CONSISTENT — so the
# body NEVER runs on either side and the executed-stdout oracle
# compares the transpiled run against live pwsh (both print only
# "after"; the body echo is structural — a wrongly-run body would
# DIFF). Truthy pwsh automatics ($true, …) DIVERGE exactly as in the
# do/for conditions and refuse through the same lowerCondVar gate.
while ($x) { Write-Output "in-loop" }
Write-Output "after"
