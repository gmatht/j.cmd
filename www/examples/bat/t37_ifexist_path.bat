@echo off
rem posix tools: mkdir echo rm
mkdir d
echo x>d\file.txt
if exist d\file.txt (echo there) else (echo no)
set p=d/file.txt
if exist %p% (echo var-there) else (echo var-no)
del /q d\file.txt
rmdir d
