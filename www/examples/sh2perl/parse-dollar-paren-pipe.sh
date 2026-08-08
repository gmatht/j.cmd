#!/bin/sh
# Nested $() containing a pipeline with subshell and redirects.
# Parser coverage: $(), (), |, and >&- redirects. (The original form raced
# in bash itself: the fd4 write could land before or after the pipeline
# teardown, so the capture was nondeterministically "" or "0".)
r=$(
    exec 4>&1
    echo "before" >&4
    (echo "sub") 3>&- | cat
    echo "after" >&4
) || {
    x=$?
}
echo "$r"
printf "%s=[%s]\n" x "${x:-}"
