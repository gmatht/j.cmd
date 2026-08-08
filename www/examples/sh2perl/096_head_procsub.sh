#!/bin/bash

head <(while true; do echo .; sleep 1; done)

echo "exit: $?"
