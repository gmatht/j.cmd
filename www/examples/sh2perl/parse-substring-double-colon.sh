#!/bin/bash
# ${var::length} substring syntax must not be confused with ${var:-default}
x="hello world"
echo "${x::-2}"
echo "${x: -3}"
