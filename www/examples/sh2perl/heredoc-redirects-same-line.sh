#!/bin/sh
# Heredoc with additional redirects on the same line
tmpf=$(mktemp /tmp/heredoc_redirect_same_line.XXXXXX)
(cmd) <<EOF 2>&1 >"$tmpf"
body
EOF
printf 'heredoc+redirects output=[%s]\n' "$(cat "$tmpf" 2>/dev/null || echo '(empty)')"
rm -f "$tmpf"
