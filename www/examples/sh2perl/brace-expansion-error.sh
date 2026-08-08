#!/bin/bash
# Brace expansion edge case
echo {1..10}
echo {a,b,c}
echo file.{txt,md}

echo "exit: $?"
