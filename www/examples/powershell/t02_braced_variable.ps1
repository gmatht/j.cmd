# t02_braced_variable: the ${name} spelling of a variable read — the
# braced_variable token of tree-sitter-powershell (the `variable` rule
# admits `$name` and `${name}` alike; the braces are pure spelling, so
# both lower to getVar("name"), byte-identical for the same store slot).
# Exercised inside a double-quoted string (the Interpolate lit/expr
# parts around the braced variable); foo is unset, so the interpolation
# prints "a  b" on both sides ($null interpolates to "").
# NOTE (live-pwsh edge, not pinned): a BARE `Write-Output ${foo}` with
# foo unset prints NOTHING in pwsh ($null is filtered from the
# pipeline), while the A1 echo of an empty store value prints a blank
# line — that null-semantic edge stays outside the v1 text-closed
# subset (refuse > guess), so the example exercises the braced spelling
# only in the exact interpolation context.
Write-Output "a ${foo} b"
