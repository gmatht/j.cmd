# Unexpected bracket - can happen with complex test expressions
# or malformed [[ ]] patterns
if [ -f "${CONF}" ]; then
  echo "exists"
fi
