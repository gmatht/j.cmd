#!/bin/bash
#Avoid arrays, use a line by line pipeline rather than buffered.
yes Line:LINE | head -n100 | while read L; do i=$((i+1)); echo "Line:$i"; done
