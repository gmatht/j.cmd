# t22_param_block: the param_block node of tree-sitter-powershell — the
# script-level `param(...)` parameter declaration. The grammar's program
# rule is `[using/requires] [param_block] statement_list`, so the node
# sits BETWEEN the directives and the statement_list as a direct child
# of program (`param($alpha, $beta)` — a `param` keyword token + `(`
# + optional parameter_list of script_parameter children + `)`; the
# parameter_list is OPTIONAL, so `param()` parses as a childless
# param_block; the t02 braced spelling `param(${name})` is the same
# variable node). The same node also hosts the param-block form of
# FUNCTION bodies, which refuse on the function itself (functions are
# the function rung, refused in v1 — the t11 return pin).
# Live pwsh 7.6.4 (verified 2026-08-16): with NO arguments the block
# leaves every parameter $null — EXACTLY like an undeclared variable —
# so within the v1 text-closed subset (the transpiled program is always
# run with an empty argv; v1 has no script-arguments channel: $args
# refuses, assignment refuses) the declaration has NO runtime effect.
# Lowering: ZERO statements — the node is dropped exactly like the t18
# label (pure spelling with no runtime effect in the subset), so the
# emitted program is byte-identical to the same program without the
# param line. Reads of the parameters lower through the usual getVar
# slots and interpolate as "" (the t09/t10 consistent edge), so the
# executed-stdout oracle matches live pwsh by construction: both print
# "alpha= beta=" then "done". The value-changing forms REFUSE (pinned
# testdata_refuse/t22_*): a script_parameter_default (`param($a = "d")`
# — pwsh binds the default when no argument is passed, divergent
# output; the assignment rung lands it) and an attribute_list
# (`param([string]$a)` / `[CmdletBinding()]` / `[Parameter()]` — the
# plan's `Param()` advanced-attribute refusal).
param($alpha, $beta)
Write-Output "alpha=$alpha beta=$beta"
Write-Output "done"
