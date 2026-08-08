#!/bin/bash
# ${var#pattern} - # is tokenized as comment inside ${}
x=${y#* }
echo "$x"
