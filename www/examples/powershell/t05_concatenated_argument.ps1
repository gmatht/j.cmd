# t05_concatenated_argument: the concatenated_command_argument node of
# tree-sitter-powershell — adjacent quoted / bareword / variable pieces
# with NO whitespace between them (`pre"mid"post`, `$x"b"`, `2"a"`).
# Live pwsh 7.6.4 argument-mode tokenization (verified with a 4-param
# argument counter): an UNQUOTED head (bareword / variable / number)
# absorbs every following piece — `pre"mid"post` is ONE argument
# "premidpost", `$x"b"` is one argument, `2"a"` is "2a" — while an
# argument that STARTS with a quoted string terminates there
# (`Write-Output "a"b` passes TWO arguments, and pwsh writes one
# pipeline OBJECT per argument). The pieces lower exactly like the
# core's adjacent-word folding: adjacent literal text merges into one
# lit part, a variable adds an expr part, an all-literal tail lowers to
# a Str (`echo premidpost` → Str "premidpost") and a variable tail to
# an Interpolate (`echo $x"b"`). A QUOTED head REFUSES: the multi-
# object output is outside the v1 single-object echo mapping (the t02
# null-edge precedent: refuse > guess). NOTE: `"a""b"` is NOT this
# node — the doubled quote is an ESCAPED quote inside one double-
# quoted string. Backtick escapes (escape_character) and `$(…)`
# sub-expressions inside a concatenated argument also REFUSE.
Write-Output pre"mid"post
Write-Output $foo"b"
Write-Output 2"a"
