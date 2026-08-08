#!/bin/bash
# Minimal reproduction of nested ${...} inside ${var:-default}
# Similar to e2scrub_all failure
echo ${MOUNTPOINT:-${NAME}}
