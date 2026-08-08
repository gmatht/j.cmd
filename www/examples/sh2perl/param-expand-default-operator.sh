#!/bin/bash
# ${var-} (default value operator without colon) should be parsed correctly
if [ "${ZSH_VERSION-}" ]; then
    echo zsh
elif [ "${BASH_VERSION-}" ]; then
    echo bash
fi
