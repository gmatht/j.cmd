#!/bin/bash
# Test [[ ... ]] || [[ ... ]] after a heredoc inside a function
test_func() {
    cat <<EOF
some content
EOF
}
if [[ -d /path1 ]] || [[ -d /path2 ]]; then
    echo "found"
fi

echo "done: $?"
