#!/bin/bash
# Pipeline failure: sort via pipe returns empty
echo "Sort test:"
printf "c\nb\na\n" | sort
echo "---"
printf "3\n1\n2\n" | sort -n
echo "done"
