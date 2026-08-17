@echo off
rem v1.2: shift + the canonical arg-loop idiom. call :loopargs binds the
rem call's args to %1..%9; shift moves them along; the -%1-==-- test
rem stops the loop when the args run out.
call :loopargs one two three
echo done
goto :eof

:loopargs
:next
if -%1-==-- goto :eof
echo arg %1
shift
goto :next
