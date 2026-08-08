#!/bin/bash

# Process substitution referencing files that may not exist
# (tests error handling, not diff output)
echo "start"
diff <(echo a) <(echo b) 2>/dev/null || true
echo "end"

echo "done: $?"
