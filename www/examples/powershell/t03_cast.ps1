# t03_cast: the cast_expression node — `[type] operand` (tree-sitter
# powershell: a type_literal followed by the operand unary_expression,
# wrapped in expression_with_unary_operator). The v1 subset reaches
# casts ONLY in command-argument position, where pwsh does NOT evaluate
# the cast: `Write-Output [string]"cast value"` prints `[string]cast
# value` (verified against live pwsh 7.6.4 — the original identity pin
# "drop the type_literal" was written against a guessed record and was
# wrong for this context). The argument lowers as an expandable string:
# lit "[string]" + the operand "cast value", and the transpiled run
# prints "[string]cast value" (also exact for `[int]5` → `[int]5`,
# `[string]$foo` → `[string]` + foo's value, nested `[string][int]5` →
# `[string][int]5`). The unary-operator forms of
# expression_with_unary_operator (`-not` / `!` / `++` / `--`) and
# object-shaped operands (member access, `@()` arrays) still REFUSE.
Write-Output [string]"cast value"
