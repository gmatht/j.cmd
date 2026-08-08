#!/bin/bash
# Minimal sample: heredoc with single quotes creates spanning strings in shell lexer
f=x.py
cat > "$f" << 'EOF'
x = re.search(r'`([^`]+)`', line)
if x == '\'': pass
EOF
printf 'wrote %d bytes to %s\n' $(wc -c < "$f") "$f"
