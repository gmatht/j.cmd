# t19_merging_redirection: the merging_redirection_operator node of
# tree-sitter-powershell — the pwsh stream-merge operator `N>&1`
# (stream N into the SUCCESS stream). The grammar's redirection rule
# is a CHOICE of this operator and the file form
# (file_redirection_operator + redirected_file_name — `> file`, on
# the by-design refused ledger, refused-powershell-sh-go.txt), and the
# node appears as a _command_element of command_elements (verified
# against the CST: `Write-Output "hi" 2>&1` → command → command_name +
# command_elements [ … redirection → merging_redirection_operator ]).
# Live pwsh 7.6.4 (verified 2026-08-14): `Write-Output "hi" 2>&1`
# prints hi, exit 0 — nothing in the v1 subset writes to streams 2-6,
# so the merge never changes the observable output; the pin guards
# the EMIT, the oracle guards that the redirect installs without
# breaking the run (the t04 invocation-operator precedent). Lowering:
# the A1 Redirect statement —
# `{"type":"Redirect","inner":[echo "hi"],"redirects":[{"fd":2,
# "mode":"w","target":Str "&1","interpolate":true}]}` — byte-identical
# to the core's `echo "hi" 2>&1` emission (verified against `debashc
# --shir --raw`): the "&N" target is the fd-dup the A1→ESTree renderer
# lowers to `sh2.redirectSync(body, [{fd:2,mode:"w",target:"&1"}])`
# and the runtime installs as a shared-fd duplicate
# (sh2-namespace.mjs _applyRedirectSpecs), so the transpiled run
# prints the same "hi". The other operator forms REFUSE
# (testdata_refuse/): `*>&1` — the all-streams merge has no numeric
# fd and the A1 IrRedirect.fd is an int (a core request would be
# needed); every `X>&2` form — pwsh 7.6.4 rejects them at parse time
# ("The 'N>&2' operator is reserved for future use") while the
# vendored grammar over-accepts (refuse > guess).
Write-Output "hi" 2>&1
