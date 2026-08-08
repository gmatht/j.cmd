#!/bin/bash
# Multiple single-quoted strings in a pipeline.
# The interaction between quotes in different parts of a pipeline
# previously caused the logos tokenizer to stop.
result=$(echo "data" | sed 's/foo/bar/g' | awk '{print $2}')
echo "$result"
