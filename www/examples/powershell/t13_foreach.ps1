# t13_foreach: the foreach_statement node of tree-sitter-powershell —
# `foreach` `(` [foreach_parameter] variable `in` pipeline `)`
# statement_block (the `foreach` keyword, parens and `in` are anonymous
# alias tokens; the named children are the optional foreach_parameter,
# the loop variable, the `in` pipeline and the body). Live pwsh 7.6.4:
# the loop iterates the `in` collection; with an UNSET variable the
# collection reads $null and the loop iterates ZERO times (the body
# never runs). The lowering is the plan's "For over the A1 array" row
# (PLAN_POWERSHELL_F.md §1): `foreach ($x in $list) { B }` → the A1 For
# statement `{var: x, iter: Array [ split [ getVar "list" ] ], body: B}`
# — the CORE's exact shape for bash `for i in $list; do …; done`
# (verified byte-identical against `debashc file --shir`; the iter
# pipeline has the SAME single-pipeline shape as the t06/t07
# conditions, so the `in` collection lowers through the same
# lowerCondPipeline subset: a bare variable read). The split wrapper is
# the word-splitting the A1 For's iter semantics implement (the estree
# renderer emits `[].concat(…)` and the runtime splits the item list):
# split("") is the EMPTY list, so the transpiled side iterates zero
# times too — the executed-stdout oracle matches live pwsh by
# construction. The body echo is structural: it never runs on either
# side, and a wrongly-run body (e.g. a bare getVar iter rendering as
# `[].concat("")` → one empty item) would DIFF. The body's
# interpolation is the t09/t10 consistent edge (an unset var
# interpolates as empty text). The foreach_parameter form
# (`foreach -parallel (…)`) REFUSES, pinned
# testdata_refuse/t13_foreach_parallel.ps1.
foreach ($x in $list) {
    Write-Output "item: $x"
}
Write-Output "done"
