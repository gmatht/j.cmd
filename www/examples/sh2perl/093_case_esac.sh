#!/bin/bash

# Case statement
x="hello"
case "$x" in
    hello) echo "Hi!" ;;
    bye)   echo "Bye!" ;;
    *)     echo "Other" ;;
esac
