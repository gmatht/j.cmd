# t07_if_else: the else_clause node of tree-sitter-powershell — the
# `else { … }` tail of an if_statement (else keyword + statement_block;
# the grammar's elseif_clauses field is a SEPARATE rung and REFUSES —
# testdata_refuse/t04_if_elseif.ps1). Lowering: `if ($c) { B } else { E }`
# → the A1 If node with cond/then/elsifs/else (the plan's "If / else-if
# chain" row, PLAN_POWERSHELL_F.md §1) — byte-identical to the core's
# `if` emission (sorted keys, no runs field; a bare `if ($c) { B }`
# without the tail lowers with else: []). The else body lowers through
# the same statement_block path as the do-body of t06.
# The condition is a bare variable read, pinned for an UNSET variable
# (the t06 precedent): pwsh reads $null (FALSY) and the A1 store reads
# "" (FALSY) — the condition-position null edge is CONSISTENT (unlike
# the t02 PRINT edge, which stays outside the subset). So BOTH oracles
# take the else branch — the executed-stdout gate compares the
# transpiled run against live pwsh and both print "no". Truthy pwsh
# automatic variables (`$true`, …) in an if condition DIVERGE exactly
# as in a while condition and REFUSE through the same lowerCondPipeline
# gate (testdata_refuse/t05_if_true.ps1).
if ($x) { Write-Output "yes" } else { Write-Output "no" }
