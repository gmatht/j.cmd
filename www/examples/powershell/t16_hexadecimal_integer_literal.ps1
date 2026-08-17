# t16_hexadecimal_integer_literal: the hexadecimal_integer_literal node
# of tree-sitter-powershell — the `0x` / `0X` prefixed form of the
# integer_literal token (hex digits plus the optional suffix; the
# decimal_integer_literal sibling has been pinned since t11). Live pwsh
# 7.6.4 argument-mode behavior (verified 2026-08-14): a hex-literal
# argument is NOT evaluated — `Write-Output 0x1F` prints the text
# `0x1F` (and `0Xab` prints `0Xab`), exactly like a bareword. The
# lowering needs no special case: lowerExpr takes the integer_literal's
# raw byte content as the argument text (the same `Write-Output 5` →
# Str path as t01), so the hex spelling flows through as a Str — the
# emitted A1 echo prints the same text and the executed-stdout oracle
# matches live pwsh by construction. The `exit` form stays decimal-
# pinned (lowerExitCode parses base 10 — `exit 0x1F` refuses, the t11
# subset), as do the t14 `-f` format args (raw text, same pass-through).
Write-Output 0x1F
Write-Output 0Xab
