#!/bin/bash
# A bare ' (closing quote of a single-quoted string) followed by content
# on the same line triggers the logos 0.15 bug.
# Previously sh2perl would fail to parse this.
function test() {
    echo 'hello world'
    RESULT=$(echo test)
}
printf "%s=[%s]\n" RESULT "${RESULT:-}"

