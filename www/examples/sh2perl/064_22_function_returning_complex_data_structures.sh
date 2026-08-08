#!/bin/bash

# 22. Function returning complex data structures
get_system_info() {
    local -A info
    info["os"]="$(uname -s)"
    info["arch"]="$(uname -m)"
    info["hostname"]="$(hostname)"
    info["user"]="$USER"
    
    # Output key=value pairs sorted by key (declare -p is bash-specific and unsupported)
    for key in "${!info[@]}"; do echo "info[$key]=${info[$key]}"; done | sort
}

# Test the function
get_system_info
