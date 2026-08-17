@echo off
set x=5
if "1"=="1" (
    echo x=%x%
    if "%x%"=="5" (
        echo deep
    ) else (
        echo shallow
    )
)
for %%i in (1 2) do (
    echo v=%x% i=%%i
)
