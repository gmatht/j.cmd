# t08_empty_statement: the empty_statement node of tree-sitter-powershell
# — a lone `;` where the _statement rule expects a statement (the
# grammar's empty_statement alternative; it parses EVERY standalone `;`
# as this node, including a trailing `;` after a pipeline — so the
# common `Write-Output "x";` spelling and the `a; ; b` double-separator
# below both exercise it; this pin has TWO empty_statement children).
# Live pwsh 7.6.4 accepts it as a NO-OP: the oracle run prints "a" then
# "b" (exit 0). Lowering: the node emits ZERO statements — dropped
# exactly like comments (the plan's `#`-comments row,
# PLAN_POWERSHELL_F.md §1; the A1 has no no-op node and needs none), so
# the emitted program is byte-identical to the same program without the
# `;` and the executed-stdout oracle matches live pwsh by construction.
Write-Output "a"; ; Write-Output "b"
