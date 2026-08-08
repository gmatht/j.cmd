#!/bin/bash
# Case pattern with command substitution inside
_docker_to_extglob() {
    echo "$1"
}
case "${words[$counter]}" in
    $(_docker_to_extglob "$subcommands") )
        echo match
        ;;
esac
