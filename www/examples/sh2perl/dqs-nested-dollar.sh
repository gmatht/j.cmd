#!/bin/bash
# Demonstrates DQS merge failure with $() nesting and embedded quotes.
# The outer DQS contains $(...) with inner "${var}" references.
name="$(echo "${USER}" | tr '[:upper:]' '[:lower:]')"
echo "$name"
