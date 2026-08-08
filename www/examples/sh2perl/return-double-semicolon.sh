#!/bin/sh
# Regression test: return followed by ;; in a case statement should parse.
# sh2perl failed to parse this because parse_return_statement did not
# treat DoubleSemicolon as a terminator for the return value.
case "$1" in
  foo) return 0 ;;
  bar) return ;;
  *)   echo "unknown" ;;
esac
