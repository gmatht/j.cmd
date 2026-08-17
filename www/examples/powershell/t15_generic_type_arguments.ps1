# t15_generic_type_arguments: the generic_type_arguments node of
# tree-sitter-powershell — the `[Type[Arg1, …]]` generic type syntax.
# It is a child of type_spec (generic_type_name `List[` +
# generic_type_arguments), reached in v1 ONLY inside the type_literal
# head of a cast_expression (`[List[int]]"x"`; the t03 [type] cast
# rung). The lowering takes the WHOLE type_literal byte span as the
# argument's literal text, so the generic spelling needs no special
# case — same lit part as `[string]`, byte-identical handling.
# Verified against live pwsh 7.6.4 (2026-08-14): argument mode does NOT
# evaluate a generic type literal — `Write-Output [List[int]]"x"`
# prints `[List[int]]x` and the dotted
# `[System.Collections.Generic.List[int]]` form prints its full text
# too (the t03 argument-mode rule holds for generic type_specs). Both
# lines pin that: the transpiled run prints the same text (the lit
# type text + the operand), the executed-stdout oracle matches by
# construction. NOTE (outside the v1 subset): a COMMA inside the type
# arguments (`[Dictionary[string,int]]"z"`) is an argument separator in
# argument mode — pwsh prints TWO pipeline objects (`[Dictionary[string`
# then `int]]z`), the multi-object shape that refuses elsewhere (the
# t05/t14 precedent); the pinned subset is the single-type-argument
# generic, exactly as here.
Write-Output [List[int]]"x"
Write-Output [System.Collections.Generic.List[int]]"y"
