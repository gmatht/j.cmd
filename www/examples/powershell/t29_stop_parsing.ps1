# t29_stop_parsing: the stop_parsing token of tree-sitter-powershell —
# the pwsh stop-parsing `--%` (the grammar's stop_parsing token
# `--%[^\r\n]*`, a _command_element of command_elements; the node text
# is `--%` PLUS the rest of its line, consumed VERBATIM — the token
# ends at the newline, so the next line starts a fresh statement, as
# the "done" line pins). Live pwsh 7.6.4 (verified 2026-08-20): with a
# CMDLET the `--%` token is passed as its OWN pipeline object and the
# verbatim remainder as ONE more — `Write-Output --% hello world`
# prints `--%` then `hello world` on TWO lines, and `Write-Output --%
# $HOME tail` prints `$HOME tail` UNEXPANDED (verbatim is the point of
# the token — no variable interpolation, no quote processing; the
# leading whitespace after the token is trimmed, interior spacing
# preserved). Both objects are COMPILE-TIME literal text (the t14 fold
# precedent), so the element lowers to ONE echo per object (the t14
# one-object-per-argument rule) — the second line pins the
# verbatim-ness: an interpolating lowering would print the home dir
# instead of `$HOME tail`. The t29 subset pins the token as the
# command's ONLY argument-producing element on the enumeration
# commands (Write-Output / echo — the t01 whitelist): preceding
# arguments (`Write-Output "pre" --% tail`), a redirection, and
# `Write-Host --% …` (Write-Host JOINS its objects on one line — the
# two-object enumeration would miscompile) all REFUSE (refuse > guess).
Write-Output --% hello world
echo --% $HOME tail
Write-Output "done"
