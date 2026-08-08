#!/bin/sh
# ${0##*[/\\]} and similar pattern-based parameter expansions
basename=${0##*[/\\]}
echo "${basename#git-}"
