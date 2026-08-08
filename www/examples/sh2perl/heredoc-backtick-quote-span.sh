#!/bin/bash
# Heredoc with single quotes and backticks that create spanning strings
f=x.py
cat > "$f" << 'EOF'
import re
func_match = re.search(r'`([^`]+)`', line)
if x == '\'': pass
EOF
printf 'wrote %d bytes to %s\n' $(wc -c < "$f") "$f"
