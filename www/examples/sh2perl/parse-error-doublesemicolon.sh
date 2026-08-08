#!/bin/sh
# Double semicolon outside of case context is a syntax error
echo hello;; echo world

echo "exit: $?"
