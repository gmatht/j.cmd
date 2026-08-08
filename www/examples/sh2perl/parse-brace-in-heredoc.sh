#!/bin/bash
# Heredoc with braces (Python/JSON code)
cat << 'EOF'
{
    "key": "value",
    "nested": {"inner": 1}
}
EOF
EOF

echo "exit: $?"
