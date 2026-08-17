@echo off
set f=out.txt
echo hi>%f%
echo more>>%f%
type out.txt
del /q out.txt
