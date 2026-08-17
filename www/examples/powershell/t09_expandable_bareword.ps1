# t09_expandable_bareword: the expandable_bareword node of
# tree-sitter-powershell — a variable immediately followed by unquoted
# literal text with NO whitespace (`$foo-bar`: the grammar's variable +
# a generic_token tail; the tail's first char cannot be `.` / `$` / `[`
# / `{` / a quote, so `$foo.txt` parses as member_access and `$foo2`
# as ONE variable token — this node is exactly the bareword-tail twin
# of the t05 variable-headed concatenation `$x"b"`). Live pwsh 7.6.4
# argument-mode tokenization (verified 2026-08-13): the variable
# expands and the tail is literal — with foo UNSET, `Write-Output
# $foo-bar` prints `-bar` (the argument starts with `$`, so `-bar` is
# NOT parsed as a parameter) and with `$foo = "abc"` it prints
# `abc-bar`. The braced spelling `${foo}-bar` parses as the SAME node
# (the t02 brace precedent — braces are pure spelling, both name the
# same getVar slot). Lowering: the pieces fold exactly like the core's
# adjacent-word folding for bash `echo $foo-bar` (byte-identical:
# Interpolate [expr getVar("foo"), lit "-bar"]) via the same
# mergeConcatParts fold as t05, and the transpiled run prints "-bar"
# on both sides (the A1 store reads "" for foo — the consistent
# condition-position-style null edge: the tail makes this an
# expandable STRING, not the bare-$null t02 print edge).
Write-Output $foo-bar
Write-Output ${foo}-bar
