@echo off
rem posix tools: cp mv rm
echo z>a.txt
copy /y a.txt b.txt >nul
move /y b.txt c.txt >nul
type c.txt
del /q a.txt c.txt
