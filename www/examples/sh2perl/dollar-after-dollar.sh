#!/bin/bash
# Minimal reproduction of '$' followed by unexpected character
# Similar to "Expected identifier or number after $"
echo $?
echo $@
echo $*
