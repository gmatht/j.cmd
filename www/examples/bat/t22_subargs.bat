@echo off
call :show one two
call :show alpha
goto :eof

:show
echo got %1 and %2
goto :eof
