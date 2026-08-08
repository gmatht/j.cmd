#!/bin/bash
# while loop with multiple commands in the condition
while
	echo "checking..."
	test -f /tmp/somefile
do
	echo "file exists"
	break
done

echo "exit: $?"
