#!/bin/bash

# Double-paren arithmetic evaluation
(( i = 1 + (2 * 3) / 4 ))
echo "i=$i"
(( j = i++ + ++i ))
echo "j=$j"
