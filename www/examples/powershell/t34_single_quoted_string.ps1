# t34_single_quoted_string: the verbatim_string_characters node of
# tree-sitter-powershell — the single-quoted '…' string_literal (the
# grammar's string_literal rule is a CHOICE of expandable_string_literal
# / verbatim_string_characters / expandable_here_string_literal /
# verbatim_here_string_characters; the literal-here-string sibling
# verbatim_here_string_characters still REFUSES — the t10 note's "later
# rung" — while this node reaches the lowerer through lowerStringLiteral
# and the stringLiteralParts path, the t01 twin). Live pwsh 7.6.4
# (verified 2026-08-21): single quotes are VERBATIM — no $var
# interpolation, no backtick escapes — `Write-Output 'hello world'`
# prints `hello world` and `Write-Output '$x not interpolated'` prints
# the literal text, EXACTLY the core's bash '…' semantics. Lowering:
# the raw interior passes through as a plain A1 Str with style
# DoubleQuoted (the t01 note's "single-quoted and barewords → Str
# DoubleQuoted", byte-identical to the core's `echo 'hello world'`
# emission — verified against `debashc --shir --raw`), so the
# executed-stdout oracle matches live pwsh by construction: both print
# `hello world` then `$x not interpolated` — the second line pins the
# VERBATIM-ness (an interpolating lowering would print the empty store
# value for $x / the home dir for $HOME; the t09/t10 consistent-edge
# discipline). The doubled-quote escape spelling ('it''s') stays
# outside the pin: the vendored runtime passes the raw interior through
# (the A1 side would print `it''s` while pwsh prints `it's` — refuse >
# guess is the t10 note's escape_character discipline; the rung pins
# the plain interior only).
Write-Output 'hello world'
Write-Output '$x not interpolated'
