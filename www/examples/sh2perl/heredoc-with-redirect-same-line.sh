# Demonstrate heredoc with output redirect on same line
tmpf=$(mktemp /tmp/heredoc_with_redirect_same_line.XXXXXX)
cat << _EOF_ > "$tmpf"
hello world
_EOF_
printf 'heredoc+same-line-redirect content=[%s]\n' "$(cat "$tmpf")"
rm -f "$tmpf"
