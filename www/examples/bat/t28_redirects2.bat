@echo off
echo one>a.txt
echo two>>a.txt
type a.txt
echo three>b.txt
type a.txt b.txt
del /q a.txt b.txt
