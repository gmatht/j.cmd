#!/bin/bash
# Pipeline failure demo: basic pipe returns empty in pure Perl mode
echo "File list:"
ls -1 /tmp 2>/dev/null | head -3
echo "---"
echo "Count:"
ls /tmp 2>/dev/null | wc -l
echo "done"
