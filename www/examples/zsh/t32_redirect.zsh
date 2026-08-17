# t32_redirect: redirect output to a file
# diagnostics: program prints its result to stdout
# (fixed shared paths can collide with a stale root-owned file in sticky
# /tmp and wedge the executed-stdout gate — the pid makes the path
# unique per run, so a stale file can never be hit again)
echo data > /tmp/zsh_t32_redirect.$$.tmp
cat /tmp/zsh_t32_redirect.$$.tmp
