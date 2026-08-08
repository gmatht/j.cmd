#!/bin/bash

get_file_size() {
    local file=$1
    local size=`wc -c < "$file"`
    echo "File $file has $size bytes"
}

get_file_size test_simple_function.sh
