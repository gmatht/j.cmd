#!/bin/sh
# Regression: empty assignment before ;; in case body
case $needop in
    '') echo empty;;
    *) x=;;
esac
