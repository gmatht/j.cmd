#!/bin/sh
# Test: (( with matching ) not )) should be parsed as nested subshells,
# NOT as arithmetic evaluation.  sh2perl must keep them as two subshells.
# The outer (...) groups the pipeline; the inner (...) runs gzip.
( (gzip -cdfq -- "$file" 4>&-; echo $? >&4) 3>&- | cat ) 5<&0
