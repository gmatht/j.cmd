#!/bin/bash
# Script with binary data after heredoc (like a self-extracting archive)
INTERPRETER_UNDER_TEST="$1"
if [[ ! -x "${INTERPRETER_UNDER_TEST}" ]]; then
    echo "Interpreter must be the command line argument."
    exit 4
fi
EXECUTABLE="$0" exec "${INTERPRETER_UNDER_TEST}" -E - <<END_OF_PYTHON
import os
import zipfile
print('Hello from embedded Python')
END_OF_PYTHON
PK
printf "%s=[%s]\n" EXECUTABLE "${EXECUTABLE:-}"

