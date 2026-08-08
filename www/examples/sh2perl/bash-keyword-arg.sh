#!/bin/bash
# Shell keywords as arguments to commands
result=$(echo "line1 pattern line2" | awk '{for(i=1;i<=NF;i++) if($i ~ /pattern/) print $i}')
printf 'awk result=[%s]\n' "$result"
