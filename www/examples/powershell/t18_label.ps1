# t18_label: the label node of tree-sitter-powershell — the `:name`
# prefix of a labeled loop (the grammar's _statement rule:
# [label] _labeled_statement; the label is a SIBLING node before the
# loop statement in the statement_list, and _labeled_statement is one
# of switch / foreach / for / while / do — v1's expressible hosts are
# do (t06), for-condition (t12) and foreach (t13); a label before a
# while / switch still refuses on the loop itself). A label has NO
# runtime effect unless a break/continue targets it, and v1 REFUSES
# break/continue (the t11 pin: loop signals whose only landed host
# would miscompile) — so every expressible program's label is
# UNREFERENCED: pure spelling, the t02 braces / t04 invocation-
# operator precedent. Lowering: the label drops and the loop lowers
# through its normal path, so the emit is byte-identical to the
# unlabeled form (here the t06 do-while duplication). Verified
# against live pwsh 7.6.4 (2026-08-14): `:outer do { … } while ($x)`
# runs identically to the unlabeled do — the label changes nothing
# observable. Pinned for an UNSET $x (the t06 condition edge): the
# body prints once on both sides, then "after". The labeled
# break/continue forms (`break :label` — the label_expression inside
# flow_control_statement) still REFUSE.
:outer do { Write-Output "once" } while ($x)
Write-Output "after"
