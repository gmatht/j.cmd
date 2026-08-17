@echo off
call :sub
call :sub
echo main-done
goto :eof

:sub
echo sub-run
goto :eof
echo never
