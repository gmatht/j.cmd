@echo off
call :list a b c
call :list one
goto :eof

:list
echo all=%*
goto :eof
