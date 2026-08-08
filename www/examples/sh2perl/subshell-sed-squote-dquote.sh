#!/bin/bash
# Regression test: commands inside $(...) that contain both single and double
# quotes (e.g. sed 's/"//g') inside a function body can cause the parser to
# enter an infinite loop inside while/for body parsing, consuming all tokens.
# This should parse without error.
function test_it {
  while true; do
    LIST+=("$(sed 's/"//g')")
    LIST+=("$(echo hello)")
  done
}
