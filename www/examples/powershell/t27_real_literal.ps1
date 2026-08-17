# t27_real_literal: the real_literal node of tree-sitter-powershell —
# the decimal real-number token (`\p{Nd}+ \. \p{Nd}+` plus the optional
# `[eE][+-]?…` exponent), the floating-point sibling of the
# integer_literal token pinned since t11/t16. Live pwsh 7.6.4
# argument-mode behavior (verified 2026-08-19): a real-literal argument
# is NOT evaluated — `Write-Output 1.50` prints the text `1.50` (a
# parsed double would format as `1.5`) and `Write-Output 1.5e3` prints
# `1.5e3` (a parsed double would print `1500`) — exactly like a
# bareword, the t16 hex-literal precedent. The lowering needs no
# evaluation: lowerExpr takes the real_literal's raw byte content as
# the argument text (the same `Write-Output 5` → Str path as t01, now
# shared with integer_literal), so the spelling flows through as a Str —
# the emitted A1 echo prints the same text and the executed-stdout
# oracle matches live pwsh by construction. The suffix forms of the
# token (`1.5d` / `1.5kb`) stay unpinned (the vendored grammar
# over-accepts them; pwsh treats them as barewords — refuse > guess
# would apply if an example tried them), as do the non-argument
# positions: `exit 1.5` and the t14 format args / t24-t25 range bounds
# keep their bare-decimal-integer pins (lowerExitCode / literalArgText /
# rangeBound accept integer_literal only — a real_literal there REFUSES,
# the t11/t14/t24 subset).
Write-Output 1.5
Write-Output 1.50
Write-Output 1.5e3
Write-Output 0.5e-1
