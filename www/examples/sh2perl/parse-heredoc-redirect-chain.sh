#!/bin/sh
# Test heredoc followed by more redirects on same line
tmpf=$(mktemp /tmp/parse_heredoc_redirect_chain.XXXXXX)
cat <<EOF 2>&1 >"$tmpf"
hello
EOF
printf 'heredoc+redirect-chain output=[%s]\n' "$(cat "$tmpf" 2>/dev/null || echo '(empty)')"
rm -f "$tmpf"
