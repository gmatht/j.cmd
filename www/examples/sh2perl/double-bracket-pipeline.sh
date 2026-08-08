#!/bin/bash
# Double bracket [[ ... ]] inside a pipeline (&& / || chain)
# Triggers the parser's handling of [[ ... ]] && cmd
[[ -n "$1" ]] && [[ -f "$1" ]] && echo "File exists: $1"
