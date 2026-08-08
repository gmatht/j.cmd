#!/bin/bash
# Multi-stage pipeline
echo "Multi-stage:"
echo "hello world" | tr ' ' '\n' | sort | head -2
echo "done"
