#!/bin/bash

outer() {
    local msg="hello"
    inner() {
        echo "$msg"
    }
    inner
}
outer
