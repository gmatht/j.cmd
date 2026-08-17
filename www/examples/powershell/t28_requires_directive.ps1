# t28_requires_directive: the requires_directive_list node of
# tree-sitter-powershell — the script-level `#requires` directive lines.
# The grammar's program rule is `[using/requires] [param_block]
# statement_list`, so the node sits at the TOP of the file, BEFORE the
# param_block / statement_list (the t22 param_block's sibling; the
# `using` form stays a by-design refusal — the plan's "`using` /
# modules" row, PLAN_POWERSHELL_F.md §1 pinned refusals). The node is a
# repeat of requires_statement children, each a requires_keyword token
# + one requires_argument_group per argument (each group wraps ONE
# requires_argument — a command_parameter / generic_token /
# integer_literal / real_literal / string_literal /
# hash_literal_expression).
# Live pwsh 7.6.4 (verified 2026-08-19): `#requires` is a script-level
# REQUIREMENT check enforced at startup in -File mode — an unmet
# requirement fails the run BEFORE any statement prints. The v1 subset
# pins ONLY requirements the pinned oracle (pwsh 7.6.4) is GUARANTEED
# to satisfy, so within the subset the directive has NO runtime effect
# and the lowering is ZERO statements — the node is dropped exactly
# like the t22 param_block (the t18-label pure-spelling precedent), so
# the emitted program is byte-identical to the same program without the
# directive lines and the executed-stdout oracle matches live pwsh by
# construction (both print "ready" then "done"). The two lines pin the
# accepted surface: the real_literal `M.m` `-Version` value and the
# `-PSEdition Core` generic_token value — EACH parameter ONCE, because
# pwsh binds the whole directive list into ONE parameter set (a second
# `-Version` anywhere — even on another line — is a parse error,
# "parameter 'version' is specified more than once"; the integer_literal
# `-Version 5` form and the multi-argument `-Version 5.1 -PSEdition
# Core` statement form share the same pairwise validation but cannot
# coexist with this example's `-Version`). The version acceptance is
# the ORACLE'S OWN release-line whitelist (PSVersionInfo.
# IsValidPSVersion — NOT a numeric comparison: `-Version 6.2` runs
# clean while `-Version 6.3` fails the run): majors 1-4 accept minor 0,
# major 5 accepts 0/1, major 6 accepts 0-2, major 7 accepts 0-6;
# `-Version 5.1` and `-PSEdition Core` both run clean here. The refuse
# edges are pinned in testdata_refuse/t28_*: an off-whitelist version
# (`6.3`, `99`), `-PSEdition Desktop`, `-Modules`, `-RunAsAdministrator`,
# a duplicate parameter, the bare-`#requires` grammar swallow and a
# mid-file `#requires`.
#requires -Version 5.1
#requires -PSEdition Core
Write-Output "ready"
Write-Output "done"
