# t23_path_command_name: the path_command_name node of
# tree-sitter-powershell — the command-name variant reached when the
# name's text needs the path token (letters/digits/_/?/-/./\/: the
# plain command_name token set EXCLUDES `-`, so a dash in the name
# forces this node). The grammar reaches it ONLY under the invocation
# operator: the `command` rule's second branch is
# command_invocation_operator + command_name_expr + command_elements,
# and command_name_expr = command_name | path_command_name |
# _primary_expression — a bare `Write-Output "x"` at statement level
# parses as the plain command_name (t01); the `&` / `.` prefix admits
# the path form, and `Write-Output` / `Write-Host` (the dash) parse as
# path_command_name. The v1 subset reaches it exactly there: a literal
# whitelisted name (echo / Write-Output / Write-Host) under the
# operator, where live pwsh 7.6.4 invocation is observationally
# identical to plain invocation — `& Write-Output "one two"` prints
# `one two`, `. Write-Output "three"` prints `three` (verified
# 2026-08-16 against live pwsh) — so the lowering needs no special
# case: lowerCommand reads the command_name FIELD child's text (the
# path_command_name node) and the t04 whitelist matches it
# case-insensitively, so the operator lowers away (the t04
# invocation-spelling precedent) and the emit is byte-identical to the
# un-prefixed form (the t01 echo shape). The executed-stdout oracle
# matches live pwsh by construction (both print one line per command,
# exit 0). A REAL path (`& ./echo`, `& sub/echo`, `. ./file.ps1`)
# parses as plain command_name (the compiled token set admits `.` and
# `/` — the dash is the distinguishing character) and REFUSES on the
# whitelist ("command ... outside the v1 subset"), as do the
# variable/string forms (`& $cmd`, `& "script.ps1"`) — the t04 note's
# "the command_name_expr text is not in the whitelist" refusals stay
# pinned (refuse > guess: the subset never guesses what the operator
# targets).
& Write-Output "one two"
. Write-Output "three"
