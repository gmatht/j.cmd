#!/bin/sh
test "/path" -ef "/other" && echo "same"

echo "exit: $?"
