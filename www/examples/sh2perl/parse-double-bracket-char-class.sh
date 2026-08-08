#!/bin/bash
# Double bracket with character class containing ]
# This can confuse the lexer when ] appears inside [[ ... ]]
if [[ "$x" =~ [abc] ]]; then
  echo match
fi
