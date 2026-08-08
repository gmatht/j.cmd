#!/bin/sh
# Heredoc with parameter expansions inside
VAR=hello
VAR2=world
if true; then
  cat <<EOF
${VAR} more ${VAR2} text
EOF
fi
printf "%s=[%s]\n" VAR "${VAR:-}"
printf "%s=[%s]\n" VAR2 "${VAR2:-}"

