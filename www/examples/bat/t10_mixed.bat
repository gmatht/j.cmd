@echo off
set total=0
set /a total=%total%+5
if "%total%"=="5" (
    echo total is %total%
) else (
    echo wrong
)
for %%i in (1 2) do echo iter %%i
goto fin
echo skipped
:fin
echo end
