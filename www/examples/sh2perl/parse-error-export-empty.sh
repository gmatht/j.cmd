#!/bin/sh
# export with empty value should be valid
export ENV=
printf 'ENV=[%s]\n' "$ENV"
