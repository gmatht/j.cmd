#!/bin/bash
# Minimal reproduction of RedirectOut inside an array/arithmetic expression
# Similar to docker/docker-compose failures
echo ${arr[1]>2}
