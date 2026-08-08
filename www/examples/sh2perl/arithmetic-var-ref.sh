#!/bin/bash
# Minimal reproduction of arithmetic expression with variable references
# Similar to git-submodule / growpart failures
echo $((var + 1))
