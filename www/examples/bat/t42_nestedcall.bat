@echo off
call :outer
goto :eof

:outer
echo outer
call :inner
echo back
goto :eof

:inner
echo inner
goto :eof
