# t26_pipeline_chain: the pipeline_chain_tail node of
# tree-sitter-powershell — the pwsh 7.0+ pipeline-chain operators `&&` /
# `||` between command pipelines (the grammar's _pipeline rule:
# pipeline_chain (pipeline_chain_tail pipeline_chain)*). NOTE the `|`
# pipe is NOT this node — the grammar parses `a | b` as ONE
# pipeline_chain whose anonymous `|` token (the _pipeline_tail rule)
# sits between two command children; pipeline_chain_tail is `&&` / `||`
# only (verified against the CST). The pre-t26 frontend refused this
# node under a mislabel — "pipeline `|` (the t08 text-pipe rung)" — but
# the pipe and the chain operator are different constructs, and the
# chain operator is expressible (the A1 BinOp And/Or; the pipe stays on
# the t08 text-pipe rung, now refused loudly instead of silently
# dropping the right-hand command — pinned testdata_refuse/t26_pipeline).
# Live pwsh 7.6.4 (verified 2026-08-18): the right-hand pipeline runs
# only when the left-hand's success flag is set — `Write-Output "a" &&
# Write-Output "b"` prints a then b, `Write-Output "c" || Write-Output
# "d"` prints c only (the `||` tail is SKIPPED: Write-Output always
# succeeds). Lowering: the A1 BinOp —
# `{"type":"BinOp","op":"And"|"Or","lhs":call,"rhs":call}` —
# byte-identical to the core's `echo "a" && echo "b"` / `echo "c" ||
# echo "d"` emission (verified against `debashc --shir --raw`): the
# A1→ESTree renderer lowers the BinOp to an `if (sh2.lastExit === 0)` /
# `if (sh2.lastExit !== 0)` guard, and within the v1 subset every
# expressible command SUCCEEDS on both sides — the transpiled run
# prints the same output as live pwsh by construction (the `&&` tail
# runs on both, the `||` tail is skipped on both; the skipped `||` tail
# is structural — a wrongly-run echo would DIFF).
# The t26 subset pins TWO chains with the plain command shape on BOTH
# sides; a chain whose command emits several statements (the t14/t24
# argument forms) or a non-Call statement (the t19 Redirect) has no
# single value to chain on, and a longer chain (3+ chains — the nested
# BinOp shape) is unpinned: all REFUSE (refuse > guess), the 3-chain
# form pinned testdata_refuse/t26_pipeline_chain_three.ps1.
Write-Output "a" && Write-Output "b"
Write-Output "c" || Write-Output "d"
