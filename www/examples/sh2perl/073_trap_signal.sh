#!/bin/bash

trap 'echo "Interrupted"' INT
echo "Trap set"

echo "exit: $?"
