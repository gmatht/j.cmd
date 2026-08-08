#!/bin/bash
# Test: 'function name ()' followed by newline then '{' must parse correctly.
function myfunc ()
{
  echo "hello"
}
myfunc

echo "exit: $?"
