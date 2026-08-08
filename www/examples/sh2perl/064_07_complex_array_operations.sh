#!/bin/bash

# 7. Complex array operations with associative arrays
declare -A config
config["user"]="admin"
config["host"]="localhost"
config["port"]="8080"

# Sort values to avoid hash-order non-determinism between bash and Perl
IFS=$'\n' sorted=($(sort <<<"${config[*]}"))
echo "Config: ${sorted[@]}"
