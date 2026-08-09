@echo off
echo start
call :greet World
call :greet Batch
echo done
goto :eof

:greet
echo hello %1
goto :eof
