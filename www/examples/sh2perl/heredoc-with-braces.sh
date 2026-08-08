#!/bin/bash
# Regression test: heredoc with Python/JS code containing braces, and other delimiters
d=$(mktemp -d)
cd "$d"
f=test.py
cat > test.py << 'PYEOF'
def foo():
    if True:
        return {"key": "value"}
PYEOF
printf 'wrote %d bytes to %s\n' $(wc -c < test.py) "$f"
cd /
rm -rf "$d"
