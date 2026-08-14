# t01_echo: the worker's first work item (the gate is RED until this
# lands). The native oracle is the RECORDED expectation in
# harness/frontend-stdout.sh (native_limits_powershell — pwsh is not
# installed on the fleet boxes; the bat precedent). The worker adds the
# record when the construct goes green.
Write-Output "hello powershell"
