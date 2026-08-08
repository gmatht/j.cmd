#!/bin/sh
# Nested case with ;; after esac
case "$1" in
  a)
    case "$2" in
      x) echo x;;
    esac;;
  b)
    echo b;;
esac
