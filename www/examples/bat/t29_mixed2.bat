@echo off
set name=bat
echo name=%name%
if "%name%"=="bat" (echo is-bat) else (echo no)
set a=x
set b=x
if "%a%"=="%b%" (
    echo equal
) else (
    echo diff
)
for %%w in (x y z) do echo word %%w
echo done&echo really
goto fin
echo never
:fin
echo the-end
