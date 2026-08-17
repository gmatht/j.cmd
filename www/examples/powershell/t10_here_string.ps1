# t10_here_string: the expandable here-string (@"…"@ — the grammar's
# expandable_here_string_literal, a string_literal body) — the
# multi-line twin of the t01 double-quoted string. Live pwsh 7.6.4
# semantics (verified 2026-08-13): the opening @" must end its line —
# the content starts after the first newline — and the newline(s)
# right before the closing "@ are NOT part of the string. Variables
# interpolate like a double-quoted string: an UNSET $foo reads $null
# and interpolates as EMPTY text (prints "a  b"), CONSISTENT with the
# A1 store's "" — the t09 argument-string edge. The pieces lower
# byte-identically to the core's bash `echo "a $foo b
# c"` (Interpolate [lit "a ", expr getVar("foo"), lit " b\nc"]), so the
# transpiled run prints the same "a  b" / "c" lines as live pwsh.
Write-Output @"
a $foo b
c
"@
