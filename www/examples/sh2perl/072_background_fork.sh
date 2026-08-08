#!/bin/bash

# Background command with wait
sleep 0.1 &
wait
echo "Background done"

echo "exit: $?"
