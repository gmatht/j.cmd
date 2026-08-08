#!/bin/sh
# Regression: $() with nested () inside test expression
if [ $(echo foo) -ne 0 ]; then
    echo bar
fi
