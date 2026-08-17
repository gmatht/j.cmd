# t31_switch: the switch_statement node of tree-sitter-powershell —
# `switch` `(` switch_condition `)` switch_body (the grammar: switch +
# optional switch_parameters + switch_condition + switch_body; the
# switch_body wraps a switch_clauses list of switch_clause children,
# each a switch_clause_condition + statement_block; the `default`
# keyword is the ANONYMOUS _switch_condition_token — a default clause's
# condition node has NO named children — and the keyword is
# case-insensitive, `Default` parses the same, verified 2026-08-21).
# The plan's switch row (PLAN_POWERSHELL_F.md §1) was a refuse-node
# while the grammar could not parse switch clause blocks — "the clib
# switch lowering is ready when the grammar closes the gap" — and the
# vendored grammar parses the full shape (verified against the CST), so
# the rung lands the plan's "clib switch lowering": the A1 Case node,
# byte-identical to the core's `case "$x" in 1) … ;; *) … ;; esac`
# emission (verified against `debashc --shir --raw`).
# The t31 subset pins a discriminant that is a bare variable read (the
# t06/t07 condition shape — an UNSET variable reads $null in pwsh and
# "" from the A1 store, and $null -eq <literal> is False exactly like
# "" failing every non-* case pattern, so the null edge is CONSISTENT:
# the FIRST switch runs its default clause on BOTH sides) or a bare
# decimal integer (the t24 range-bound precedent — pwsh matches
# `switch (2)` by -eq against the literal clauses and the A1 `case
# "2"` pattern text coincides: the SECOND switch runs its `2` clause
# on BOTH sides — a wrongly-matched clause would DIFF). Clause
# conditions are bare decimal integer_literals or a TRAILING `default`
# (refuse > guess: a default before a later clause diverges — pwsh
# runs the matching later clause and skips the default while the A1
# `*` pattern would match FIRST, verified against live pwsh — and
# duplicate clause values diverge — pwsh runs EVERY matching clause,
# the A1 case runs the first match only; string / bareword conditions
# REFUSE — pwsh's `-eq` is case-INSENSITIVE for strings while the A1
# pattern match is case-sensitive). The switch_parameters form
# (`switch -Regex/-Wildcard/-Case/-Exact/-File …`) and the -File
# condition REFUSE, pinned testdata_refuse/t31_*.ps1. The executed-
# stdout oracle compares the transpiled run against live pwsh 7.6.4:
# both print "d" then "two".
switch ($x) {
  1 { Write-Output "one" }
  2 { Write-Output "two" }
  default { Write-Output "d" }
}
switch (2) {
  1 { Write-Output "one" }
  2 { Write-Output "two" }
  default { Write-Output "d" }
}
