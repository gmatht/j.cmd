#!/bin/bash

# This script demonstrates basic shell functionality
echo "Hello, World!"

# Valid if statement
if [ -f "test.txt" ]; then
    echo "File exists"
fi

# Valid for loop
for i in {1..5}; do
    echo $i
done 

#Bash leaves $i as 5 after the loop. But it is messy to add this if i will not be used later.
#PERL_MUST_NOT_CONTAIN: $i = 5;

#Only use basename if actually needed.
#PERL_MUST_NOT_CONTAIN: basename

# "Hello, World!\n" is simpler
#PERL_MUST_NOT_CONTAIN: "Hello, World!", "\n"
#PERL_MUST_CONTAIN: "Hello, World!\n"

