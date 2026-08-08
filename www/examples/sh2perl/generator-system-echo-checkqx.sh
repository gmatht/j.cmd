#!/bin/sh
# Generator produces system('/bin/echo') which check_qx.pl flags
INFO() {
  /bin/echo -e "hello $@"
}
WARNING() {
  /bin/echo >&2 -e "warning $@"
}
INFO "test"
