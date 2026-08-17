# t32_redirect: redirect output to a file
# diagnostics: program prints its result to stdout
f=$(mktemp)
echo data > "$f"
cat "$f"
rm -f "$f"
