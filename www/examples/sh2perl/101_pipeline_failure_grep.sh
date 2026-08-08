#!/bin/bash
# Pipeline failure: grep via pipe returns empty
echo "Grep test:"
echo "alpha beta gamma" | grep beta
echo "---"
echo "alpha beta gamma" | grep -o beta
echo "done"
