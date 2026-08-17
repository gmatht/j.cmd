@echo off
rem posix tools: cp rm cat mv rmdir mkdir ls
mkdir batcmd
echo one>batcmd\a.txt
copy batcmd\a.txt batcmd\b.txt >nul
type batcmd\b.txt
ren batcmd\b.txt c.txt
type batcmd\c.txt
dir /b batcmd
del /q batcmd\a.txt
move batcmd\c.txt batcmd\d.txt >nul
type batcmd\d.txt
del /q batcmd\d.txt
rmdir batcmd
