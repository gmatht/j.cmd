#!/bin/bash
# Minimal reproduction of unexpected token in brace expansion
# Similar to exe_with_zip / mysql-server-8.0.postrm failures
echo {1..5}
echo ${!var*}
