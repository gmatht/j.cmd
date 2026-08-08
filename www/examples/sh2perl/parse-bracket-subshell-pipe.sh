#!/bin/bash
# [[ $(cmd | grep -w pattern) ]] && assignment
[[ -n $(service lightdm status 2>/dev/null | grep -w active) ]] && x="yes"
