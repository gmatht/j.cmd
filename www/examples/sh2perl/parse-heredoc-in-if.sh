#!/bin/sh
# heredoc inside if/then
f() {
  if true; then
    cat <<EOF
hello
EOF
  fi
}
f

echo "exit: $?"
