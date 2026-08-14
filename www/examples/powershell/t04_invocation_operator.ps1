# t04_invocation_operator: the command_invocation_operator node of
# tree-sitter-powershell — a `.` / `&` prefix on a command (the call
# operator `&` and the dot-source operator `.`). The grammar's `command`
# rule admits command_invocation_operator + command_name_expr +
# command_elements alongside the plain command_name form. The v1 subset
# reaches the operator ONLY before a literal whitelisted command name
# (echo / Write-Output / Write-Host), where live pwsh 7.6.4 invocation
# is observationally identical to plain invocation — `& echo hello` and
# `. echo hello` both print `hello`, `& Write-Output "one two"` prints
# `one two` — so the operator lowers away (pure invocation spelling,
# the ${}-brace precedent of t02; the emit is byte-identical to the
# un-prefixed form). A variable / string / path command name
# (`& $cmd`, `& "script.ps1"`, `. ./file.ps1`) REFUSES: the
# command_name_expr text is not in the whitelist, so the subset never
# guesses what the operator targets.
& echo hello
. echo "world"
