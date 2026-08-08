#!/bin/bash
if [[ "abc" =~ ^[a-z]{1,3}$ ]]; then
  echo "match"
fi
